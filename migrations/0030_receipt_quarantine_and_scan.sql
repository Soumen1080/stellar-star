-- ============================================================================
-- Stellar-star Migration 0030: Receipt quarantine, scan, and upload intents (#451)
-- ============================================================================
-- Client metadata must not decide readable receipt content.
--
-- This migration introduces:
--   1. Short-lived upload intents (public.receipt_upload_intents) with expiry.
--   2. Explicit status tracking: pending -> quarantined -> promoted/rejected/abandoned.
--   3. RPC for atomic promotion of quarantined uploads to active receipts.
--   4. RLS policies ensuring upload intents are tenant-isolated and owner-scoped.
--
-- Rollback: forward-only and non-destructive. To revert:
--   DROP FUNCTION IF EXISTS public.promote_receipt_intent(UUID, UUID, TEXT, TEXT, TEXT, INT, TEXT, TEXT, JSONB);
--   DROP TABLE IF EXISTS public.receipt_upload_intents;

-- ─── Receipt upload intents ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.receipt_upload_intents (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id          UUID NOT NULL REFERENCES public.expenses (id) ON DELETE CASCADE,
  wallet              TEXT NOT NULL,
  idempotency_key     TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'quarantined', 'promoted', 'rejected', 'abandoned')),
  file_name           TEXT CHECK (file_name IS NULL OR char_length(file_name) <= 120),
  content_type        TEXT CHECK (content_type IS NULL OR content_type IN (
                        'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'
                      )),
  size_bytes          INT CHECK (size_bytes IS NULL OR size_bytes > 0),
  checksum_sha256     TEXT CHECK (checksum_sha256 IS NULL OR checksum_sha256 ~ '^[0-9a-f]{64}$'),
  caption             TEXT CHECK (caption IS NULL OR char_length(caption) <= 200),
  storage_path        TEXT,
  promoted_path       TEXT,
  scan_result         JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt_id          UUID REFERENCES public.expense_receipts (id) ON DELETE SET NULL,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT receipt_upload_intents_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_receipt_upload_intents_expense
  ON public.receipt_upload_intents (expense_id);

CREATE INDEX IF NOT EXISTS idx_receipt_upload_intents_wallet_created
  ON public.receipt_upload_intents (wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_receipt_upload_intents_expired
  ON public.receipt_upload_intents (expires_at)
  WHERE status IN ('pending', 'quarantined');

ALTER TABLE public.receipt_upload_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS receipt_upload_intents_select ON public.receipt_upload_intents;
CREATE POLICY receipt_upload_intents_select ON public.receipt_upload_intents
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND (
      wallet = public.current_wallet()
      OR EXISTS (
        SELECT 1 FROM public.expenses e
        WHERE e.id = receipt_upload_intents.expense_id
          AND e.member_wallets @> ARRAY[public.current_wallet()]
      )
    )
  );

GRANT SELECT ON public.receipt_upload_intents TO authenticated;

-- ─── Atomic promotion RPC ───────────────────────────────────────────────────
-- Promotes a staged upload intent to an active receipt row in a single transaction.
-- Verifies intent validity and expiry before insertion.
CREATE OR REPLACE FUNCTION public.promote_receipt_intent(
  p_intent_id        UUID,
  p_receipt_id       UUID,
  p_promoted_path    TEXT,
  p_retain_until     TIMESTAMPTZ
)
RETURNS public.expense_receipts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_intent  public.receipt_upload_intents%ROWTYPE;
  v_receipt public.expense_receipts%ROWTYPE;
BEGIN
  SELECT * INTO v_intent
    FROM public.receipt_upload_intents
   WHERE id = p_intent_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'UPLOAD_INTENT_NOT_FOUND';
  END IF;

  IF v_intent.status NOT IN ('pending', 'quarantined') THEN
    RAISE EXCEPTION 'UPLOAD_INTENT_INVALID_STATUS: %', v_intent.status;
  END IF;

  IF NOW() > v_intent.expires_at THEN
    UPDATE public.receipt_upload_intents
       SET status = 'abandoned', updated_at = NOW()
     WHERE id = p_intent_id;
    RAISE EXCEPTION 'UPLOAD_INTENT_EXPIRED';
  END IF;

  -- Insert promoted active receipt record
  INSERT INTO public.expense_receipts (
    id,
    expense_id,
    storage_path,
    file_name,
    content_type,
    size_bytes,
    checksum_sha256,
    caption,
    status,
    scan_result,
    uploaded_by_wallet,
    retain_until
  ) VALUES (
    p_receipt_id,
    v_intent.expense_id,
    p_promoted_path,
    v_intent.file_name,
    v_intent.content_type,
    v_intent.size_bytes,
    v_intent.checksum_sha256,
    v_intent.caption,
    'active',
    v_intent.scan_result,
    v_intent.wallet,
    p_retain_until
  )
  RETURNING * INTO v_receipt;

  -- Mark intent as promoted
  UPDATE public.receipt_upload_intents
     SET status = 'promoted',
         promoted_path = p_promoted_path,
         receipt_id = p_receipt_id,
         updated_at = NOW()
   WHERE id = p_intent_id;

  RETURN v_receipt;
END;
$fn$;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0030', '0030_receipt_quarantine_and_scan', 'receipt_quarantine_scan_v1')
ON CONFLICT (version) DO NOTHING;
