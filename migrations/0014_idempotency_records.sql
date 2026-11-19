-- ============================================================================
-- Migration 0014: Idempotency Keys for Money-Adjacent Mutations (#312)
-- ============================================================================
-- 1. Creates idempotency_records table to serialize mutations and deduplicate retries.
-- 2. Ties deduplication key to the authenticated wallet and request fingerprint.
-- 3. Enables RLS and indexes for fast lookup.

CREATE TABLE IF NOT EXISTS public.idempotency_records (
  key                 TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  response_status     INT,
  response_body       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 minute'),
  CONSTRAINT idempotency_records_wallet_key_unique UNIQUE (wallet_address, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_lookup
  ON public.idempotency_records (wallet_address, key);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at
  ON public.idempotency_records (created_at DESC);

ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "idempotency_records_select_self" ON public.idempotency_records;
CREATE POLICY "idempotency_records_select_self" ON public.idempotency_records
  FOR SELECT USING (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS "idempotency_records_insert_self" ON public.idempotency_records;
CREATE POLICY "idempotency_records_insert_self" ON public.idempotency_records
  FOR INSERT WITH CHECK (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS "idempotency_records_update_self" ON public.idempotency_records;
CREATE POLICY "idempotency_records_update_self" ON public.idempotency_records
  FOR UPDATE USING (wallet_address = public.current_wallet())
             WITH CHECK (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS "idempotency_records_delete_self" ON public.idempotency_records;
CREATE POLICY "idempotency_records_delete_self" ON public.idempotency_records
  FOR DELETE USING (wallet_address = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_records TO authenticated;

-- Record migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0014', '0014_idempotency_records', 'idempotency_records_312_v1')
ON CONFLICT (version) DO NOTHING;
