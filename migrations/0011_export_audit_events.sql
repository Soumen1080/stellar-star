-- ============================================================================
-- Stellar-star Migration 0011: Export audit log (#324)
-- ============================================================================
-- Every portable-archive export request — served or refused — appends one row.
-- The archive route writes it with the caller's own session, before any data
-- is returned, and refuses the export if the write fails (fail closed).
--
-- Append-only: INSERT and SELECT policies only, so under RLS a wallet can read
-- its own export history but nobody can edit or delete it.

CREATE TABLE IF NOT EXISTS public.export_audit_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_wallet   TEXT        NOT NULL,
  export_kind    TEXT        NOT NULL CHECK (export_kind IN ('archive')),
  status         TEXT        NOT NULL CHECK (status IN ('served', 'rate_limited', 'forbidden', 'failed')),
  trip_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  trip_count     INT         NOT NULL DEFAULT 0 CHECK (trip_count >= 0),
  expense_count  INT         NOT NULL DEFAULT 0 CHECK (expense_count >= 0),
  byte_size      INT         NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- SHA-256 of the archive body, so a file can later be matched to its record.
  content_sha256 TEXT,
  request_id     TEXT,
  -- Salted hash, not the raw IP: enough to spot abuse, not to track people.
  client_ip_hash TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_audit_events_actor_created_at
  ON public.export_audit_events (actor_wallet, created_at DESC);

ALTER TABLE public.export_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_audit_events_select_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_select_actor ON public.export_audit_events
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS export_audit_events_insert_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_insert_actor ON public.export_audit_events
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.export_audit_events TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0011', '0011_export_audit_events', 'export_audit_events_v1')
ON CONFLICT (version) DO NOTHING;
