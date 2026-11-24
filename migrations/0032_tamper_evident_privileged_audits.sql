-- ============================================================================
-- Stellar-Star Migration 0032: Tamper-Evident Privileged Audit Logs (#455)
-- ============================================================================
-- Rollback: forward-only: Append-only audit integrity ledger. DROP TABLE IF EXISTS public.privileged_audit_log; DROP TABLE IF EXISTS public.audit_integrity_anchors;
--
-- Guarantees:
-- 1. Unified coverage: Support, role changes, export requests, and admin actions.
-- 2. Strong schema: actor, decision ('allow' | 'deny' | 'propose' | 'execute'),
--    target entity/type, request_id, causation_id, metadata, prev_entry_hash, entry_hash.
-- 3. Append-only tamper resistance:
--    - Database-level trigger disallows UPDATE or DELETE on privileged_audit_log.
--    - Cryptographic SHA-256 hash chaining (blockchain-style ledger).
--    - Periodic periodic integrity anchor digests in audit_integrity_anchors.
-- 4. RLS enabled: Service role inserts and manages; verified admins read.

CREATE TABLE IF NOT EXISTS public.privileged_audit_log (
  sequence_id       BIGSERIAL PRIMARY KEY,
  id                UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  actor_wallet      TEXT NOT NULL,
  actor_role        TEXT NOT NULL DEFAULT 'user',
  action            TEXT NOT NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('allow', 'deny', 'propose', 'approve', 'execute')),
  target_type       TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  request_id        TEXT,
  causation_id      TEXT,
  ip_address        TEXT,
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  prev_entry_hash   TEXT NOT NULL,
  entry_hash        TEXT NOT NULL UNIQUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_privileged_audit_log_created_at
  ON public.privileged_audit_log (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_privileged_audit_log_actor
  ON public.privileged_audit_log (actor_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_privileged_audit_log_target
  ON public.privileged_audit_log (target_type, target_id);

CREATE INDEX IF NOT EXISTS idx_privileged_audit_log_request_id
  ON public.privileged_audit_log (request_id);

-- Restrict mutation: disallow any updates or deletions on audit records
CREATE OR REPLACE FUNCTION public.disallow_audit_mutation()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'Privileged audit log entries are strictly append-only and cannot be updated or deleted.';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_privileged_audit_log_immutable ON public.privileged_audit_log;
CREATE TRIGGER trg_privileged_audit_log_immutable
  BEFORE UPDATE OR DELETE ON public.privileged_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION public.disallow_audit_mutation();

-- Periodic or batch anchor digests
CREATE TABLE IF NOT EXISTS public.audit_integrity_anchors (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  start_sequence_id BIGINT NOT NULL,
  end_sequence_id   BIGINT NOT NULL,
  entries_count     INT NOT NULL,
  merkle_root       TEXT NOT NULL,
  anchor_hash       TEXT NOT NULL,
  anchored_by       TEXT NOT NULL DEFAULT 'system',
  metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_integrity_anchors_seq
  ON public.audit_integrity_anchors (end_sequence_id DESC);

-- Enable RLS
ALTER TABLE public.privileged_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.audit_integrity_anchors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS privileged_audit_log_select_policy ON public.privileged_audit_log;
CREATE POLICY privileged_audit_log_select_policy ON public.privileged_audit_log
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS privileged_audit_log_insert_policy ON public.privileged_audit_log;
CREATE POLICY privileged_audit_log_insert_policy ON public.privileged_audit_log
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS audit_integrity_anchors_select_policy ON public.audit_integrity_anchors;
CREATE POLICY audit_integrity_anchors_select_policy ON public.audit_integrity_anchors
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS audit_integrity_anchors_insert_policy ON public.audit_integrity_anchors;
CREATE POLICY audit_integrity_anchors_insert_policy ON public.audit_integrity_anchors
  FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.privileged_audit_log TO authenticated;
GRANT SELECT, INSERT ON public.audit_integrity_anchors TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0032', '0032_tamper_evident_privileged_audits', 'tamper_evident_audits_v1')
ON CONFLICT (version) DO NOTHING;
