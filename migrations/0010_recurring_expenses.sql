-- ============================================================================
-- Stellar-star Migration 0010: Recurring expense templates & scheduled drafts
-- (issue #319)
-- ============================================================================
-- Rent, utilities and subscriptions repeat. A template describes the series;
-- a scheduled job (or the trip page) turns each due occurrence into a DRAFT.
-- A draft is a suggestion: it becomes an expense only when a member reviews it
-- in the normal expense form and saves it. Nothing in this schema can move
-- money or request a wallet signature.

-- ─── Templates ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.recurring_expense_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            UUID REFERENCES public.trips (id) ON DELETE CASCADE,
  title              TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description        TEXT        CHECK (description IS NULL OR char_length(description) <= 100),
  category           TEXT        CHECK (category IS NULL OR category IN (
                       'food', 'groceries', 'lodging', 'transport', 'activities', 'shopping',
                       'utilities', 'rent', 'subscriptions', 'health', 'other'
                     )),
  tags               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (cardinality(tags) <= 10),
  currency           TEXT        NOT NULL DEFAULT 'XLM',
  amount_kind        TEXT        NOT NULL CHECK (amount_kind IN ('fixed', 'variable')),
  amount             TEXT        CHECK (amount IS NULL OR amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  split_mode         TEXT        NOT NULL CHECK (split_mode IN ('equal', 'custom')),
  paid_by_member_id  TEXT        NOT NULL,
  members            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cadence_unit       TEXT        NOT NULL CHECK (cadence_unit IN ('day', 'week', 'month', 'year')),
  cadence_interval   INT         NOT NULL CHECK (cadence_interval BETWEEN 1 AND 365),
  start_date         DATE        NOT NULL,
  end_date           DATE,
  -- Earliest date the generator may produce; moved forward on resume so a
  -- pause is never back-filled.
  generate_from      DATE        NOT NULL,
  reminder_lead_days INT         CHECK (reminder_lead_days IS NULL OR reminder_lead_days BETWEEN 0 AND 30),
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  version            INT         NOT NULL DEFAULT 1,
  created_by_wallet  TEXT        NOT NULL,
  member_wallets     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_templates_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT recurring_templates_fixed_amount_check CHECK (amount_kind <> 'fixed' OR amount IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_recurring_templates_member_wallets
  ON public.recurring_expense_templates USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_trip
  ON public.recurring_expense_templates (trip_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_active
  ON public.recurring_expense_templates (id) WHERE status = 'active';

-- Same integrity pipeline as expenses/trips: identity frozen, access array
-- derived from members (never trusted from the client), updated_at stamped.
DROP TRIGGER IF EXISTS trg_01_recurring_templates_freeze_identity ON public.recurring_expense_templates;
CREATE TRIGGER trg_01_recurring_templates_freeze_identity
  BEFORE UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

DROP TRIGGER IF EXISTS trg_02_recurring_templates_sync_member_wallets ON public.recurring_expense_templates;
CREATE TRIGGER trg_02_recurring_templates_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

DROP TRIGGER IF EXISTS trg_03_recurring_templates_set_updated_at ON public.recurring_expense_templates;
CREATE TRIGGER trg_03_recurring_templates_set_updated_at
  BEFORE UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.recurring_expense_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_templates_select_members ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_select_members ON public.recurring_expense_templates
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

DROP POLICY IF EXISTS recurring_templates_insert_own ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_insert_own ON public.recurring_expense_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.current_wallet() IS NOT NULL AND created_by_wallet = public.current_wallet());

DROP POLICY IF EXISTS recurring_templates_update_members ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_update_members ON public.recurring_expense_templates
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()])
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

-- No DELETE policy: a series is ended, not deleted, so the drafts and expenses
-- it produced keep a valid source.

-- ─── Occurrence exceptions (skip / edit one future occurrence) ──────────────

CREATE TABLE IF NOT EXISTS public.recurring_expense_exceptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID        NOT NULL REFERENCES public.recurring_expense_templates (id) ON DELETE CASCADE,
  occurrence_date   DATE        NOT NULL,
  action            TEXT        NOT NULL CHECK (action IN ('skip', 'override')),
  overrides         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_exceptions_one_per_occurrence UNIQUE (template_id, occurrence_date)
);

ALTER TABLE public.recurring_expense_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_exceptions_members ON public.recurring_expense_exceptions;
CREATE POLICY recurring_exceptions_members ON public.recurring_expense_exceptions
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.recurring_expense_templates t
      WHERE t.id = recurring_expense_exceptions.template_id
        AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.recurring_expense_templates t
      WHERE t.id = recurring_expense_exceptions.template_id
        AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- ─── Drafts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        UUID        NOT NULL REFERENCES public.recurring_expense_templates (id),
  template_version   INT         NOT NULL,
  trip_id            UUID,
  occurrence_date    DATE        NOT NULL,
  payload            JSONB       NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'dismissed')),
  expense_id         UUID REFERENCES public.expenses (id) ON DELETE SET NULL,
  member_wallets     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  resolved_by_wallet TEXT,
  -- The idempotency key: one draft per occurrence, however often the job runs.
  CONSTRAINT expense_drafts_one_per_occurrence UNIQUE (template_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_expense_drafts_member_wallets
  ON public.expense_drafts USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_expense_drafts_trip_occurrence
  ON public.expense_drafts (trip_id, occurrence_date);

-- Access and scope come from the template, never from the inserting client;
-- once created, the snapshot (payload, source, date) is immutable.
CREATE OR REPLACE FUNCTION public.prepare_expense_draft()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  tmpl RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT trip_id, member_wallets INTO tmpl
      FROM public.recurring_expense_templates
     WHERE id = NEW.template_id;
    NEW.trip_id := tmpl.trip_id;
    NEW.member_wallets := COALESCE(tmpl.member_wallets, ARRAY[]::TEXT[]);
    NEW.status := 'pending';
    NEW.expense_id := NULL;
    NEW.resolved_at := NULL;
    NEW.resolved_by_wallet := NULL;
  ELSE
    NEW.id := OLD.id;
    NEW.template_id := OLD.template_id;
    NEW.template_version := OLD.template_version;
    NEW.trip_id := OLD.trip_id;
    NEW.occurrence_date := OLD.occurrence_date;
    NEW.payload := OLD.payload;
    NEW.member_wallets := OLD.member_wallets;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_01_expense_drafts_prepare ON public.expense_drafts;
CREATE TRIGGER trg_01_expense_drafts_prepare
  BEFORE INSERT OR UPDATE ON public.expense_drafts
  FOR EACH ROW EXECUTE FUNCTION public.prepare_expense_draft();

ALTER TABLE public.expense_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_drafts_select_members ON public.expense_drafts;
CREATE POLICY expense_drafts_select_members ON public.expense_drafts
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

-- member_wallets is copied from the template by the trigger above, so this
-- check means "the inserting wallet is a member of the source template".
DROP POLICY IF EXISTS expense_drafts_insert_members ON public.expense_drafts;
CREATE POLICY expense_drafts_insert_members ON public.expense_drafts
  FOR INSERT TO authenticated
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

DROP POLICY IF EXISTS expense_drafts_update_members ON public.expense_drafts;
CREATE POLICY expense_drafts_update_members ON public.expense_drafts
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()])
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

GRANT SELECT, INSERT, UPDATE ON public.recurring_expense_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_expense_exceptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.expense_drafts TO authenticated;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0010', '0010_recurring_expenses', 'recurring_expenses_v1')
ON CONFLICT (version) DO NOTHING;
