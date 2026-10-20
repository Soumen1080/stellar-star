-- ============================================================================
-- Stellar-star Migration 0009: Receipt attachments with private storage
-- (issue #318)
-- ============================================================================
-- Receipts are private documents. The files live in a PRIVATE storage bucket
-- reachable only with the service-role key; clients never get a public URL,
-- only a signed link minted by the server after a membership check.
--
-- This table is the metadata and the access-control anchor: clients may READ
-- rows for expenses they are a member of (same rule as expenses), and nobody
-- but the server writes them.

CREATE TABLE IF NOT EXISTS public.expense_receipts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SET NULL, not CASCADE: deleting an expense must not orphan the stored file
  -- silently. A NULL expense_id is picked up by the retention sweep, which
  -- deletes the object and tombstones the row.
  expense_id         UUID REFERENCES public.expenses (id) ON DELETE SET NULL,
  storage_path       TEXT        NOT NULL UNIQUE,
  file_name          TEXT        CHECK (file_name IS NULL OR char_length(file_name) <= 120),
  content_type       TEXT        NOT NULL CHECK (content_type IN (
                       'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'
                     )),
  size_bytes         INT         NOT NULL CHECK (size_bytes > 0),
  checksum_sha256    TEXT        NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  caption            TEXT        CHECK (caption IS NULL OR char_length(caption) <= 200),
  status             TEXT        NOT NULL DEFAULT 'active'
                       CHECK (status IN ('active', 'quarantined', 'removed')),
  scan_result        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by_wallet TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retain_until       TIMESTAMPTZ NOT NULL,
  removed_at         TIMESTAMPTZ,
  removed_by_wallet  TEXT,
  removal_reason     TEXT        CHECK (removal_reason IS NULL OR removal_reason IN ('user', 'retention', 'expense_deleted'))
);

-- Listing an expense's receipts, newest first.
CREATE INDEX IF NOT EXISTS idx_expense_receipts_expense_created_at
  ON public.expense_receipts (expense_id, created_at DESC);

-- The retention sweep scans live rows by expiry.
CREATE INDEX IF NOT EXISTS idx_expense_receipts_retain_until
  ON public.expense_receipts (retain_until)
  WHERE status <> 'removed';

-- The same bytes attached twice to one expense is a mistake, not two receipts.
CREATE UNIQUE INDEX IF NOT EXISTS expense_receipts_live_checksum_key
  ON public.expense_receipts (expense_id, checksum_sha256)
  WHERE status <> 'removed';

ALTER TABLE public.expense_receipts ENABLE ROW LEVEL SECURITY;

-- Read-only for members of the parent expense. No INSERT/UPDATE/DELETE
-- policies: every write goes through the server routes, which authorize the
-- caller first and then act with the service role.
DROP POLICY IF EXISTS expense_receipts_select_members ON public.expense_receipts;
CREATE POLICY expense_receipts_select_members ON public.expense_receipts
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_receipts.expense_id
        AND e.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

GRANT SELECT ON public.expense_receipts TO authenticated;

-- ─── Private storage bucket ─────────────────────────────────────────────────
-- Guarded so the migration also applies to a plain Postgres without Supabase
-- Storage (CI, local restores). No storage.objects policies are created, so
-- anon/authenticated cannot list, read or write the bucket at all.
DO $bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN
    RETURN;
  END IF;

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'storage' AND table_name = 'buckets'
               AND column_name = 'allowed_mime_types') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES (
      'expense-receipts', 'expense-receipts', FALSE, 4194304,
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf']
    )
    ON CONFLICT (id) DO UPDATE
      SET public = FALSE,
          file_size_limit = EXCLUDED.file_size_limit,
          allowed_mime_types = EXCLUDED.allowed_mime_types;
  ELSE
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('expense-receipts', 'expense-receipts', FALSE)
    ON CONFLICT (id) DO UPDATE SET public = FALSE;
  END IF;
END
$bucket$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0009', '0009_expense_receipts', 'expense_receipts_v1')
ON CONFLICT (version) DO NOTHING;
