-- ============================================================================
-- Stellar-star Migration 0008: Trip templates & duplicate-from-history (#321)
-- ============================================================================
-- Repeated groups (flatmates, teams, annual trips) can save a trip's structure
-- as a template, or start a new trip from a template or a past trip.
--
-- Guarantees enforced here rather than trusted from the client:
--   1. A copy never carries history. create_trip_from_copy writes
--      expense_ids = '{}' and settled = FALSE whatever the payload says.
--   2. Copies are idempotent. The caller supplies an idempotency key; a retry
--      with the same key returns the row the first call created.
--   3. Copies are audited. Every successful copy appends one immutable row to
--      trip_copy_events in the same transaction as the write it describes.
--   4. A caller can only copy what RLS already lets them read.
-- See docs/DESIGN_TRIP_TEMPLATES.md.

-- ── Trip structure columns ──────────────────────────────────────────────────
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS starts_on           DATE,
  ADD COLUMN IF NOT EXISTS ends_on             DATE,
  ADD COLUMN IF NOT EXISTS recurring_rules     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS permissions         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_template_id  TEXT,
  ADD COLUMN IF NOT EXISTS copied_from_trip_id TEXT;

-- ── Templates ───────────────────────────────────────────────────────────────
-- Private to the wallet that saved them. No balances, shares or payments: the
-- columns that would hold them do not exist.
CREATE TABLE IF NOT EXISTS public.trip_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet     TEXT        NOT NULL,
  name             TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  description      TEXT,
  members          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recurring_rules  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  permissions      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  duration_days    INT         CHECK (duration_days IS NULL OR duration_days > 0),
  source_trip_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_templates_owner_created_at
  ON public.trip_templates (owner_wallet, created_at DESC);

DROP TRIGGER IF EXISTS trip_templates_set_updated_at ON public.trip_templates;
CREATE TRIGGER trip_templates_set_updated_at
  BEFORE UPDATE ON public.trip_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.trip_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_templates_select_owner ON public.trip_templates;
CREATE POLICY trip_templates_select_owner ON public.trip_templates
  FOR SELECT USING (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_insert_owner ON public.trip_templates;
CREATE POLICY trip_templates_insert_owner ON public.trip_templates
  FOR INSERT WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_update_owner ON public.trip_templates;
CREATE POLICY trip_templates_update_owner ON public.trip_templates
  FOR UPDATE USING      (owner_wallet = public.current_wallet())
             WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_delete_owner ON public.trip_templates;
CREATE POLICY trip_templates_delete_owner ON public.trip_templates
  FOR DELETE USING (owner_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_templates TO authenticated;

-- ── Copy audit log ──────────────────────────────────────────────────────────
-- Append-only: there is no UPDATE or DELETE policy, so under RLS a row can be
-- written once (by the function below, as the caller) and never rewritten.
CREATE TABLE IF NOT EXISTS public.trip_copy_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT        NOT NULL,
  operation        TEXT        NOT NULL
                   CHECK (operation IN ('trip_to_template', 'template_to_trip', 'trip_to_trip')),
  actor_wallet     TEXT        NOT NULL,
  source_kind      TEXT        NOT NULL CHECK (source_kind IN ('template', 'trip')),
  source_id        TEXT        NOT NULL,
  target_kind      TEXT        NOT NULL CHECK (target_kind IN ('template', 'trip')),
  target_id        TEXT        NOT NULL,
  -- Counts of what was copied, for the audit trail. Never balances or amounts.
  summary          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_copy_events_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_trip_copy_events_actor_created_at
  ON public.trip_copy_events (actor_wallet, created_at DESC);

ALTER TABLE public.trip_copy_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_copy_events_select_actor ON public.trip_copy_events;
CREATE POLICY trip_copy_events_select_actor ON public.trip_copy_events
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_copy_events_insert_actor ON public.trip_copy_events;
CREATE POLICY trip_copy_events_insert_actor ON public.trip_copy_events
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.trip_copy_events TO authenticated;

-- ── create_trip_from_copy ───────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: every read and write below runs under the
-- caller's RLS, so a source the caller cannot see is reported as not found.
CREATE OR REPLACE FUNCTION public.create_trip_from_copy(
  p_idempotency_key TEXT,
  p_source_kind     TEXT,
  p_source_id       TEXT,
  p_trip            JSONB
)
RETURNS SETOF public.trips
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_wallet   TEXT := public.current_wallet();
  v_event    public.trip_copy_events%ROWTYPE;
  v_trip_id  UUID;
  v_name     TEXT := btrim(COALESCE(p_trip ->> 'name', ''));
  v_members  JSONB := COALESCE(p_trip -> 'members', '[]'::jsonb);
  v_rules    JSONB := COALESCE(p_trip -> 'recurring_rules', '[]'::jsonb);
  v_starts   DATE := NULLIF(p_trip ->> 'starts_on', '')::DATE;
  v_ends     DATE := NULLIF(p_trip ->> 'ends_on', '')::DATE;
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'COPY_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
    RAISE EXCEPTION 'COPY_INVALID_KEY';
  END IF;
  IF p_source_kind NOT IN ('template', 'trip') THEN
    RAISE EXCEPTION 'COPY_INVALID_SOURCE';
  END IF;

  -- Replay: the same key always resolves to the trip it first created.
  SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trips WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: name is required';
  END IF;
  IF jsonb_typeof(v_members) <> 'array' OR jsonb_array_length(v_members) < 2 THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: at least two members are required';
  END IF;
  IF jsonb_typeof(v_rules) <> 'array' THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: recurring_rules must be an array';
  END IF;
  IF v_starts IS NOT NULL AND v_ends IS NOT NULL AND v_ends < v_starts THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: end date precedes start date';
  END IF;

  IF p_source_kind = 'template' THEN
    PERFORM 1 FROM public.trip_templates WHERE id::TEXT = p_source_id;
  ELSE
    PERFORM 1 FROM public.trips WHERE id::TEXT = p_source_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COPY_SOURCE_NOT_FOUND';
  END IF;

  v_trip_id := COALESCE(NULLIF(p_trip ->> 'id', '')::UUID, gen_random_uuid());

  -- Claim the key before writing. A concurrent call with the same key blocks
  -- on the unique index, then sees the conflict and returns the winner's row.
  INSERT INTO public.trip_copy_events (
    idempotency_key, operation, actor_wallet,
    source_kind, source_id, target_kind, target_id, summary
  ) VALUES (
    p_idempotency_key,
    CASE WHEN p_source_kind = 'template' THEN 'template_to_trip' ELSE 'trip_to_trip' END,
    v_wallet,
    p_source_kind, p_source_id, 'trip', v_trip_id::TEXT,
    jsonb_build_object(
      'member_count', jsonb_array_length(v_members),
      'recurring_rule_count', jsonb_array_length(v_rules),
      'has_dates', v_starts IS NOT NULL OR v_ends IS NOT NULL,
      'excluded', jsonb_build_array('expenses', 'shares', 'payments', 'balances', 'settled')
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trips WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  INSERT INTO public.trips (
    id, name, description, members, expense_ids, settled, created_by_wallet,
    starts_on, ends_on, recurring_rules, permissions,
    source_template_id, copied_from_trip_id
  ) VALUES (
    v_trip_id,
    v_name,
    NULLIF(btrim(COALESCE(p_trip ->> 'description', '')), ''),
    v_members,
    ARRAY[]::TEXT[],          -- history is never copied
    FALSE,
    v_wallet,
    v_starts,
    v_ends,
    v_rules,
    COALESCE(p_trip -> 'permissions', '{}'::jsonb),
    CASE WHEN p_source_kind = 'template' THEN p_source_id END,
    CASE WHEN p_source_kind = 'trip' THEN p_source_id END
  );

  RETURN QUERY SELECT * FROM public.trips WHERE id = v_trip_id;
END;
$fn$;

-- ── save_trip_template ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_trip_template(
  p_idempotency_key TEXT,
  p_source_trip_id  TEXT,
  p_template        JSONB
)
RETURNS SETOF public.trip_templates
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_wallet      TEXT := public.current_wallet();
  v_event       public.trip_copy_events%ROWTYPE;
  v_template_id UUID := gen_random_uuid();
  v_name        TEXT := btrim(COALESCE(p_template ->> 'name', ''));
  v_members     JSONB := COALESCE(p_template -> 'members', '[]'::jsonb);
  v_rules       JSONB := COALESCE(p_template -> 'recurring_rules', '[]'::jsonb);
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'COPY_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
    RAISE EXCEPTION 'COPY_INVALID_KEY';
  END IF;

  SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trip_templates WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'COPY_INVALID_TEMPLATE: name is required';
  END IF;
  IF jsonb_typeof(v_members) <> 'array' OR jsonb_typeof(v_rules) <> 'array' THEN
    RAISE EXCEPTION 'COPY_INVALID_TEMPLATE: members and recurring_rules must be arrays';
  END IF;

  PERFORM 1 FROM public.trips WHERE id::TEXT = p_source_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COPY_SOURCE_NOT_FOUND';
  END IF;

  INSERT INTO public.trip_copy_events (
    idempotency_key, operation, actor_wallet,
    source_kind, source_id, target_kind, target_id, summary
  ) VALUES (
    p_idempotency_key, 'trip_to_template', v_wallet,
    'trip', p_source_trip_id, 'template', v_template_id::TEXT,
    jsonb_build_object(
      'member_count', jsonb_array_length(v_members),
      'recurring_rule_count', jsonb_array_length(v_rules),
      'excluded', jsonb_build_array('expenses', 'shares', 'payments', 'balances', 'settled')
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trip_templates WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  INSERT INTO public.trip_templates (
    id, owner_wallet, name, description, members, recurring_rules,
    permissions, duration_days, source_trip_id
  ) VALUES (
    v_template_id,
    v_wallet,
    v_name,
    NULLIF(btrim(COALESCE(p_template ->> 'description', '')), ''),
    v_members,
    v_rules,
    COALESCE(p_template -> 'permissions', '{}'::jsonb),
    NULLIF(p_template ->> 'duration_days', '')::INT,
    p_source_trip_id
  );

  RETURN QUERY SELECT * FROM public.trip_templates WHERE id = v_template_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.create_trip_from_copy(TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_trip_template(TEXT, TEXT, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0008', '0008_trip_templates', 'trip_templates_v1')
ON CONFLICT (version) DO NOTHING;
