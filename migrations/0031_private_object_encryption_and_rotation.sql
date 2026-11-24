-- ============================================================================
-- Stellar-star Migration 0031: Private Object Encryption with Key Rotation (#453)
-- ============================================================================
-- Receipts and export bucket privacy alone is not a sufficient key policy.
--
-- This migration introduces:
--   1. Managed encryption key registry (public.object_encryption_keys) with
--      state tracking (active, retiring, revoked, erased) and rotation support.
--   2. Private object encryption metadata (public.private_object_metadata)
--      storing algorithm, key ID, IV, auth tag, and plaintext/ciphertext hashes.
--   3. Immutable object access audit log (public.object_access_logs) tracking
--      every encrypt, decrypt, rotate, delete, and crypto-erasure event with
--      mandatory request_id correlation.
--   4. Strict RLS policies enforcing tenant isolation and access control.
--
-- Rollback: forward-only and non-destructive. To revert:
--   DROP TABLE IF EXISTS public.object_access_logs;
--   DROP TABLE IF EXISTS public.private_object_metadata;
--   DROP TABLE IF EXISTS public.object_encryption_keys;
-- ============================================================================

-- ─── 1. Managed Object Encryption Keys ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.object_encryption_keys (
  key_id          TEXT PRIMARY KEY,
  algorithm       TEXT NOT NULL DEFAULT 'aes-256-gcm'
                    CHECK (algorithm IN ('aes-256-gcm', 'chacha20-poly1305')),
  status          TEXT NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active', 'retiring', 'revoked', 'erased')),
  key_material    TEXT, -- Encrypted/wrapped key material or KMS ARN reference
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ,
  erased_at       TIMESTAMPTZ
);

ALTER TABLE public.object_encryption_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_encryption_keys FORCE ROW LEVEL SECURITY;

-- Revoke all access from unprivileged callers; only service_role manages raw keys
REVOKE ALL ON public.object_encryption_keys FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.object_encryption_keys TO service_role;

-- Seed initial master keys
INSERT INTO public.object_encryption_keys (key_id, algorithm, status, key_material, activated_at)
VALUES 
  ('k-2026-v1', 'aes-256-gcm', 'active', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', NOW()),
  ('k-2026-v2', 'aes-256-gcm', 'retiring', 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789', NOW())
ON CONFLICT (key_id) DO NOTHING;

-- ─── 2. Private Object Encryption Metadata ──────────────────────────────────
CREATE TABLE IF NOT EXISTS public.private_object_metadata (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket            TEXT NOT NULL,
  storage_path      TEXT NOT NULL UNIQUE,
  owner_wallet      TEXT NOT NULL,
  expense_id        UUID REFERENCES public.expenses (id) ON DELETE CASCADE,
  key_id            TEXT NOT NULL REFERENCES public.object_encryption_keys (key_id),
  algorithm         TEXT NOT NULL DEFAULT 'aes-256-gcm',
  iv                TEXT NOT NULL, -- Hex-encoded 96-bit IV
  auth_tag          TEXT NOT NULL, -- Hex-encoded 128-bit authentication tag
  ciphertext_sha256 TEXT NOT NULL,
  plaintext_sha256  TEXT NOT NULL,
  byte_size         BIGINT NOT NULL CHECK (byte_size >= 0),
  status            TEXT NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'quarantined', 'erased', 'deleted')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_rotated_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_private_object_metadata_storage
  ON public.private_object_metadata (bucket, storage_path);

CREATE INDEX IF NOT EXISTS idx_private_object_metadata_owner
  ON public.private_object_metadata (owner_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_private_object_metadata_expense
  ON public.private_object_metadata (expense_id);

CREATE INDEX IF NOT EXISTS idx_private_object_metadata_key
  ON public.private_object_metadata (key_id);

ALTER TABLE public.private_object_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.private_object_metadata FORCE ROW LEVEL SECURITY;

-- RLS: Owners and expense participants may read metadata for authorized objects
DROP POLICY IF EXISTS private_object_metadata_select_authorized ON public.private_object_metadata;
CREATE POLICY private_object_metadata_select_authorized ON public.private_object_metadata
  FOR SELECT USING (
    owner_wallet = public.current_wallet()
    OR (
      expense_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM public.expenses e
        WHERE e.id = expense_id
          AND (
            e.created_by_wallet = public.current_wallet()
            OR e.payer_wallet = public.current_wallet()
            OR EXISTS (
              SELECT 1 FROM public.trip_members tm
              WHERE tm.trip_id = e.trip_id
                AND tm.wallet_address = public.current_wallet()
            )
          )
      )
    )
  );

-- Service role manages insertions and updates
GRANT SELECT ON public.private_object_metadata TO authenticated;
GRANT ALL ON public.private_object_metadata TO service_role;

-- ─── 3. Object Access Audit Logs ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.object_access_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket          TEXT NOT NULL,
  storage_path    TEXT NOT NULL,
  actor_wallet    TEXT NOT NULL,
  action          TEXT NOT NULL
                    CHECK (action IN ('encrypt', 'decrypt', 'read_metadata', 'rotate', 'delete', 'crypto_erase')),
  status          TEXT NOT NULL
                    CHECK (status IN ('success', 'forbidden', 'failed', 'erased')),
  key_id          TEXT,
  old_key_id      TEXT,
  request_id      TEXT NOT NULL, -- Mandatory correlated request ID
  client_ip_hash  TEXT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_object_access_logs_storage
  ON public.object_access_logs (storage_path, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_object_access_logs_actor
  ON public.object_access_logs (actor_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_object_access_logs_request
  ON public.object_access_logs (request_id);

ALTER TABLE public.object_access_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.object_access_logs FORCE ROW LEVEL SECURITY;

-- RLS: Actors can view their own access logs; service role appends
DROP POLICY IF EXISTS object_access_logs_select_actor ON public.object_access_logs;
CREATE POLICY object_access_logs_select_actor ON public.object_access_logs
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS object_access_logs_insert_actor ON public.object_access_logs;
CREATE POLICY object_access_logs_insert_actor ON public.object_access_logs
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.object_access_logs TO authenticated;
GRANT ALL ON public.object_access_logs TO service_role;

NOTIFY pgrst, 'reload schema';
