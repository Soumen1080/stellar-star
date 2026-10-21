-- ============================================================================
-- Migration 0013: Privacy, Data Retention & Account Deletion (#310)
-- ============================================================================
-- 1. Creates deleted_accounts registry to invalidate stale sessions, realtime
--    subscriptions, and storage access for deleted accounts.
-- 2. Updates public.current_wallet() to fail closed (return NULL) for deleted accounts.
-- 3. Provides stored procedure public.delete_user_account for atomic off-chain erasure.

CREATE TABLE IF NOT EXISTS public.deleted_accounts (
  wallet_address TEXT PRIMARY KEY,
  deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason         TEXT NOT NULL DEFAULT 'user_request'
);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
  ON public.deleted_accounts (deleted_at DESC);

ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;

-- Service role and authenticated users can read deletion status
CREATE POLICY "deleted_accounts_select_all" ON public.deleted_accounts
  FOR SELECT USING (true);

-- Only authenticated users for their own wallet can record deletion
CREATE POLICY "deleted_accounts_insert_self" ON public.deleted_accounts
  FOR INSERT WITH CHECK (
    wallet_address = NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
  );

GRANT SELECT, INSERT ON public.deleted_accounts TO anon, authenticated;

-- ── Hardened current_wallet() ────────────────────────────────────────────────
-- Fails closed immediately for any session whose wallet is in deleted_accounts.
-- This revokes access across PostgREST RLS, Realtime subscriptions, and storage.
CREATE OR REPLACE FUNCTION public.current_wallet()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $fn$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.deleted_accounts
       WHERE wallet_address = NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
    ) THEN NULL
    ELSE NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
  END;
$fn$;

-- ── Atomic Deletion Stored Procedure ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_user_account(p_wallet_address TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := public.current_wallet();
  v_target TEXT := btrim(p_wallet_address);
BEGIN
  -- Caller must be the account owner or executing via service_role (v_caller IS NULL)
  IF v_caller IS NOT NULL AND v_caller <> v_target THEN
    RAISE EXCEPTION 'Unauthorized: cannot delete another user account' USING ERRCODE = '42501';
  END IF;

  -- 1. Insert into deleted_accounts
  INSERT INTO public.deleted_accounts (wallet_address, deleted_at, reason)
  VALUES (v_target, NOW(), 'user_request')
  ON CONFLICT (wallet_address) DO UPDATE
    SET deleted_at = NOW();

  -- 2. Delete user profile
  DELETE FROM public.users WHERE wallet_address = v_target;

  -- 3. Delete owned contacts
  DELETE FROM public.contacts WHERE owner_wallet = v_target;

  -- 4. Revoke active invites
  UPDATE public.trip_invites
     SET revoked = true,
         revoked_at = NOW()
   WHERE created_by_wallet = v_target
     AND revoked = false;

  -- 5. Mark uploaded receipts as removed
  UPDATE public.expense_receipts
     SET status = 'removed',
         removal_reason = 'user',
         removed_at = NOW(),
         removed_by_wallet = v_target
   WHERE uploaded_by_wallet = v_target
     AND status <> 'removed';

  -- 6. Delete challenges
  DELETE FROM public.auth_challenges WHERE address = v_target;

  RETURN jsonb_build_object(
    'success', true,
    'wallet_address', v_target,
    'deleted_at', NOW()
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.delete_user_account(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_user_account(TEXT) TO authenticated;

-- Record migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0013', '0013_privacy_retention_deletion', 'privacy_retention_310_v1')
ON CONFLICT (version) DO NOTHING;
