-- ============================================================================
-- Migration 0018: Incident-Response & Support Console and Audit Logs (#314)
-- ============================================================================
-- 1. Creates support_audit_logs to log every staff customer data lookup.
-- 2. Creates support_corrective_actions for dual-control (Four-Eyes Principle)
--    exceptional financial state modifications.
-- 3. Enables RLS and performance indexes.

-- ─── 1. SUPPORT AUDIT LOGS ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_audit_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_identifier TEXT NOT NULL,
  query_type       TEXT NOT NULL,
  query_value      TEXT NOT NULL,
  results_count    INT  NOT NULL DEFAULT 0,
  ip_address       TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_created_at
  ON public.support_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_staff
  ON public.support_audit_logs (staff_identifier);

ALTER TABLE public.support_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_audit_logs_select_authenticated ON public.support_audit_logs;
CREATE POLICY support_audit_logs_select_authenticated ON public.support_audit_logs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS support_audit_logs_insert_authenticated ON public.support_audit_logs;
CREATE POLICY support_audit_logs_insert_authenticated ON public.support_audit_logs
  FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.support_audit_logs TO authenticated;

-- ─── 2. DUAL-CONTROL CORRECTIVE ACTIONS ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_corrective_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  ticket_ref       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_by      TEXT NOT NULL,
  proposed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  status           TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'executed', 'rejected', 'expired')),
  execution_result JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_corrective_actions_status
  ON public.support_corrective_actions (status, proposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_corrective_actions_ticket
  ON public.support_corrective_actions (ticket_ref);

ALTER TABLE public.support_corrective_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_corrective_actions_select_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_select_authenticated ON public.support_corrective_actions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS support_corrective_actions_insert_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_insert_authenticated ON public.support_corrective_actions
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS support_corrective_actions_update_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_update_authenticated ON public.support_corrective_actions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.support_corrective_actions TO authenticated;

-- ─── 3. RECORD MIGRATION ─────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0018', '0018_support_console_and_audit', 'support_console_and_audit_314_v1')
ON CONFLICT (version) DO NOTHING;
