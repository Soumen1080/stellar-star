-- Durable, bounded webhook delivery. Endpoint secrets stay server-side and
-- delivery rows are unique per endpoint/event so re-enqueueing is harmless.
CREATE TABLE IF NOT EXISTS public.webhook_endpoints (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT NOT NULL,
  url TEXT NOT NULL CHECK (url ~ '^https://'),
  secret TEXT NOT NULL,
  events TEXT[] NOT NULL CHECK (cardinality(events) BETWEEN 1 AND 8),
  description TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  disabled_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK ((active AND disabled_at IS NULL) OR NOT active)
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_wallet_created_idx
  ON public.webhook_endpoints (wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS public.webhook_outbox (
  id UUID NOT NULL,
  endpoint_id UUID NOT NULL REFERENCES public.webhook_endpoints(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','processing','delivered','dead')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 8),
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until TIMESTAMPTZ,
  status_code INTEGER,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  PRIMARY KEY (endpoint_id, id)
);
CREATE INDEX IF NOT EXISTS webhook_outbox_due_idx
  ON public.webhook_outbox (next_attempt_at, created_at)
  WHERE status IN ('pending','processing');

ALTER TABLE public.webhook_endpoints ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_outbox ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.webhook_endpoints, public.webhook_outbox FROM anon, authenticated;
GRANT ALL ON public.webhook_endpoints, public.webhook_outbox TO service_role;

CREATE OR REPLACE FUNCTION public.claim_webhook_deliveries(p_limit INTEGER DEFAULT 25)
RETURNS SETOF public.webhook_outbox
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
BEGIN
  IF p_limit < 1 OR p_limit > 25 THEN RAISE EXCEPTION 'claim limit must be 1..25'; END IF;
  RETURN QUERY
    WITH due AS (
      SELECT id FROM public.webhook_outbox
       WHERE attempts < 8 AND next_attempt_at <= NOW()
         AND (status = 'pending' OR (status = 'processing' AND locked_until < NOW()))
       ORDER BY next_attempt_at, created_at
       FOR UPDATE SKIP LOCKED LIMIT p_limit
    )
    UPDATE public.webhook_outbox o
       SET status = 'processing', attempts = attempts + 1,
           locked_until = NOW() + INTERVAL '30 seconds'
      FROM due WHERE o.id = due.id RETURNING o.*;
END; $fn$;
REVOKE ALL ON FUNCTION public.claim_webhook_deliveries(INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_webhook_deliveries(INTEGER) TO service_role;

CREATE OR REPLACE FUNCTION public.record_webhook_failure(p_endpoint_id UUID)
RETURNS VOID LANGUAGE SQL SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
  UPDATE public.webhook_endpoints
     SET consecutive_failures = consecutive_failures + 1,
         active = CASE WHEN consecutive_failures + 1 >= 10 THEN FALSE ELSE active END,
         disabled_at = CASE WHEN consecutive_failures + 1 >= 10 THEN NOW() ELSE disabled_at END,
         updated_at = NOW()
   WHERE id = p_endpoint_id;
$fn$;
REVOKE ALL ON FUNCTION public.record_webhook_failure(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_webhook_failure(UUID) TO service_role;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_durable_webhook_delivery', 'durable_webhooks_476_v1')
ON CONFLICT (version) DO NOTHING;
