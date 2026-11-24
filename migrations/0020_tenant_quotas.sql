-- ============================================================================
-- Migration 0020: Tenant Quota Limits and Usage Tracking (#462)
-- ============================================================================
--
-- Rollback: forward-only and non-destructive. To revert:
--   DROP FUNCTION IF EXISTS public.meter_tenant_realtime_event() CASCADE;
--   DROP FUNCTION IF EXISTS public.consume_tenant_quotas CASCADE;
--   DROP FUNCTION IF EXISTS public.check_tenant_quotas CASCADE;
--   DROP TABLE IF EXISTS public.tenant_quota_objects;
--   DROP TABLE IF EXISTS public.tenant_quota_usage;
--   DROP TABLE IF EXISTS public.tenant_quota_limits;
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.tenant_quota_limits (
  wallet_address TEXT PRIMARY KEY,
  objects_limit BIGINT NOT NULL DEFAULT 500 CHECK (objects_limit >= 0),
  bytes_limit BIGINT NOT NULL DEFAULT 1073741824 CHECK (bytes_limit >= 0),
  jobs_per_minute BIGINT NOT NULL DEFAULT 60 CHECK (jobs_per_minute >= 0),
  events_per_minute BIGINT NOT NULL DEFAULT 600 CHECK (events_per_minute >= 0),
  requests_per_minute BIGINT NOT NULL DEFAULT 600 CHECK (requests_per_minute >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.tenant_quota_usage (
  wallet_address TEXT NOT NULL,
  metric TEXT NOT NULL CHECK (metric IN ('objects', 'bytes', 'jobs', 'events', 'api_requests')),
  window_start BIGINT NOT NULL,
  used BIGINT NOT NULL CHECK (used >= 0),
  PRIMARY KEY (wallet_address, metric, window_start)
);
CREATE TABLE IF NOT EXISTS public.tenant_quota_objects (
  resource_id TEXT PRIMARY KEY,
  wallet_address TEXT NOT NULL,
  byte_count BIGINT NOT NULL CHECK (byte_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tenant_quota_usage_window_idx
  ON public.tenant_quota_usage (metric, window_start);

ALTER TABLE public.tenant_quota_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_limits FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_usage ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_usage FORCE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tenant_quota_objects FORCE ROW LEVEL SECURITY;
REVOKE ALL ON public.tenant_quota_limits, public.tenant_quota_usage, public.tenant_quota_objects FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.tenant_quota_limits, public.tenant_quota_usage, public.tenant_quota_objects TO service_role;

CREATE OR REPLACE FUNCTION public.consume_tenant_quotas(
  p_wallet_address TEXT,
  p_objects BIGINT DEFAULT 0,
  p_bytes BIGINT DEFAULT 0,
  p_jobs BIGINT DEFAULT 0,
  p_events BIGINT DEFAULT 0,
  p_requests BIGINT DEFAULT 0,
  p_resource_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_wallet TEXT := upper(btrim(p_wallet_address));
  v_role TEXT;
  v_now BIGINT := floor(extract(epoch FROM clock_timestamp()) / 60)::BIGINT * 60;
  v_limits public.tenant_quota_limits%ROWTYPE;
  v_metric TEXT;
  v_amount BIGINT;
  v_limit BIGINT;
  v_window BIGINT;
  v_used BIGINT;
  v_reset_ms BIGINT;
  v_blocked_metric TEXT;
BEGIN
  v_role := COALESCE(
    NULLIF(current_setting('request.jwt.claim.role', true), ''),
    current_setting('request.jwt.claims', true)::jsonb ->> 'role',
    ''
  );
  IF v_role <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  IF v_wallet = '' OR length(v_wallet) > 128
     OR LEAST(p_objects, p_bytes, p_jobs, p_events, p_requests) < 0
     OR GREATEST(p_objects, p_bytes, p_jobs, p_events, p_requests) > 1073741824 THEN
    RAISE EXCEPTION 'invalid quota request' USING ERRCODE = '22023';
  END IF;
  IF p_objects + p_bytes + p_jobs + p_events + p_requests = 0 THEN
    RAISE EXCEPTION 'at least one positive quota amount is required' USING ERRCODE = '22023';
  END IF;
  IF (p_objects > 0 OR p_bytes > 0) AND (p_resource_id IS NULL OR btrim(p_resource_id) = '') THEN
    RAISE EXCEPTION 'storage quota reservations require a resource ID' USING ERRCODE = '22023';
  END IF;

  -- One transaction-scoped lock serializes all metric checks for this tenant.
  PERFORM pg_advisory_xact_lock(hashtextextended(v_wallet, 462));
  INSERT INTO public.tenant_quota_limits (wallet_address) VALUES (v_wallet)
  ON CONFLICT (wallet_address) DO NOTHING;
  SELECT * INTO v_limits FROM public.tenant_quota_limits
   WHERE wallet_address = v_wallet FOR UPDATE;

  FOR v_metric, v_amount, v_limit IN
    SELECT * FROM (VALUES
      ('objects', p_objects, v_limits.objects_limit),
      ('bytes', p_bytes, v_limits.bytes_limit),
      ('jobs', p_jobs, v_limits.jobs_per_minute),
      ('events', p_events, v_limits.events_per_minute),
      ('api_requests', p_requests, v_limits.requests_per_minute)
    ) AS requested(metric, amount, quota_limit)
    WHERE amount > 0
  LOOP
    v_window := CASE WHEN v_metric IN ('objects', 'bytes') THEN 0 ELSE v_now END;
    SELECT used INTO v_used FROM public.tenant_quota_usage
     WHERE wallet_address = v_wallet AND metric = v_metric AND window_start = v_window;
    IF COALESCE(v_used, 0) + v_amount > v_limit THEN
      v_blocked_metric := v_metric;
      v_reset_ms := CASE WHEN v_window = 0 THEN 0
                    ELSE GREATEST(0, ((v_now + 60) * 1000) - floor(extract(epoch FROM clock_timestamp()) * 1000)::BIGINT)
                    END;
      RETURN jsonb_build_object('allowed', false, 'metric', v_blocked_metric, 'reset_ms', v_reset_ms);
    END IF;
  END LOOP;

  IF p_objects > 0 OR p_bytes > 0 THEN
    INSERT INTO public.tenant_quota_objects(resource_id, wallet_address, byte_count)
    VALUES (p_resource_id, v_wallet, p_bytes);
  END IF;

  FOR v_metric, v_amount IN
    SELECT metric, amount FROM (VALUES
      ('objects', p_objects), ('bytes', p_bytes), ('jobs', p_jobs),
      ('events', p_events), ('api_requests', p_requests)
    ) AS requested(metric, amount)
    WHERE amount > 0
  LOOP
    v_window := CASE WHEN v_metric IN ('objects', 'bytes') THEN 0 ELSE v_now END;
    INSERT INTO public.tenant_quota_usage (wallet_address, metric, window_start, used)
    VALUES (v_wallet, v_metric, v_window, v_amount)
    ON CONFLICT (wallet_address, metric, window_start)
    DO UPDATE SET used = public.tenant_quota_usage.used + EXCLUDED.used;
  END LOOP;
  RETURN jsonb_build_object('allowed', true, 'metric', NULL, 'reset_ms', 0);
END;
$fn$;

REVOKE ALL ON FUNCTION public.consume_tenant_quotas(TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_tenant_quotas(TEXT, BIGINT, BIGINT, BIGINT, BIGINT, BIGINT, TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.release_tenant_storage_quota(p_resource_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  allocation public.tenant_quota_objects%ROWTYPE;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
     AND COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'role', '') <> 'service_role' THEN
    RAISE EXCEPTION 'service role required' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.tenant_quota_objects WHERE resource_id = p_resource_id RETURNING * INTO allocation;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(allocation.wallet_address, 462));
  UPDATE public.tenant_quota_usage SET used = GREATEST(0, used - 1)
   WHERE wallet_address = allocation.wallet_address AND metric = 'objects' AND window_start = 0;
  UPDATE public.tenant_quota_usage SET used = GREATEST(0, used - allocation.byte_count)
   WHERE wallet_address = allocation.wallet_address AND metric = 'bytes' AND window_start = 0;
  RETURN true;
END;
$fn$;
REVOKE ALL ON FUNCTION public.release_tenant_storage_quota(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_tenant_storage_quota(TEXT) TO service_role;

CREATE OR REPLACE FUNCTION public.meter_tenant_realtime_event()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_row JSONB;
  v_wallet TEXT;
  v_now BIGINT := floor(extract(epoch FROM clock_timestamp()) / 60)::BIGINT * 60;
  v_limit BIGINT;
  v_used BIGINT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_row := to_jsonb(OLD);
  ELSE
    v_row := to_jsonb(NEW);
  END IF;
  v_wallet := upper(btrim(COALESCE(
    public.current_wallet(),
    v_row ->> 'created_by_wallet', v_row ->> 'owner_wallet',
    v_row ->> 'sender_wallet', v_row ->> 'wallet_address'
  )));
  IF v_wallet IS NULL OR v_wallet = '' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(v_wallet, 463));
  INSERT INTO public.tenant_quota_limits (wallet_address) VALUES (v_wallet)
  ON CONFLICT (wallet_address) DO NOTHING;
  SELECT events_per_minute INTO v_limit FROM public.tenant_quota_limits
   WHERE wallet_address = v_wallet FOR UPDATE;
  SELECT used INTO v_used FROM public.tenant_quota_usage
   WHERE wallet_address = v_wallet AND metric = 'events' AND window_start = v_now;
  IF COALESCE(v_used, 0) + 1 > v_limit THEN
    RAISE EXCEPTION 'Tenant realtime event quota exceeded'
      USING ERRCODE = 'PT429', DETAIL = 'Retry after the current quota window.';
  END IF;
  INSERT INTO public.tenant_quota_usage (wallet_address, metric, window_start, used)
  VALUES (v_wallet, 'events', v_now, 1)
  ON CONFLICT (wallet_address, metric, window_start)
  DO UPDATE SET used = public.tenant_quota_usage.used + 1;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$fn$;
REVOKE ALL ON FUNCTION public.meter_tenant_realtime_event() FROM PUBLIC, anon, authenticated;

DO $triggers$
DECLARE relation RECORD;
BEGIN
  FOR relation IN
    SELECT DISTINCT p.schemaname, p.tablename
      FROM pg_publication_tables p
      JOIN information_schema.columns c
        ON c.table_schema = p.schemaname AND c.table_name = p.tablename
     WHERE p.schemaname = 'public'
       AND c.column_name IN ('created_by_wallet', 'owner_wallet', 'sender_wallet', 'wallet_address')
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS tenant_realtime_quota ON %I.%I', relation.schemaname, relation.tablename);
    EXECUTE format('CREATE TRIGGER tenant_realtime_quota BEFORE INSERT OR UPDATE OR DELETE ON %I.%I FOR EACH ROW EXECUTE FUNCTION public.meter_tenant_realtime_event()', relation.schemaname, relation.tablename);
  END LOOP;
END;
$triggers$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0020', '0020_tenant_quotas', 'atomic_tenant_quota_v1')
ON CONFLICT (version) DO NOTHING;
