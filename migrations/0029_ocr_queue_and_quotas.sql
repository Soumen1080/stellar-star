-- ============================================================================
-- Stellar-star Migration 0029: OCR queue with per-user/trip quotas (#452)
-- ============================================================================
-- Moves OCR processing to quota-controlled background workers.
--
-- Design:
--   1. Upload endpoint stores the file and enqueues an OCR job — fast, no OCR.
--   2. A leased-queue pattern (like reconciliation) lets workers claim jobs
--      with row-level locking; each job runs in isolation with a CPU/time cap.
--   3. Per-user and per-trip quotas are enforced at enqueue time by counting
--      recent jobs (sliding window). Over-quota requests are rejected before
--      a file even touches the queue, so storage never piles up.
--   4. OCR results (text, confidence, provenance, parsed fields) are persisted
--      in an `ocr_results` table linked to the receipt. The front-end polls or
--      subscribes until the result lands.
--   5. OCR-suggested data **never** writes to `expenses` without an explicit
--      human review step (the existing ReceiptDraftReview UI enforces this, and
--      the API double-checks `reviewed: true` on every field).

-- ─── OCR job queue ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ocr_jobs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_id       UUID        NOT NULL REFERENCES public.expense_receipts (id) ON DELETE CASCADE,
  expense_id       UUID,
  trip_id          UUID,
  wallet           TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'leased', 'completed', 'failed', 'cancelled')),
  priority         INT         NOT NULL DEFAULT 0,
  -- Leased-queue fields
  leased_at        TIMESTAMPTZ,
  leased_by        TEXT,
  lease_expires_at TIMESTAMPTZ,
  -- Worker isolation
  timeout_ms       INT         NOT NULL DEFAULT 60000 CHECK (timeout_ms > 0 AND timeout_ms <= 120000),
  attempts         INT         NOT NULL DEFAULT 0,
  max_attempts     INT         NOT NULL DEFAULT 3,
  last_error       TEXT,
  -- Timestamps
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at       TIMESTAMPTZ,
  completed_at     TIMESTAMPTZ
);

-- Workers poll for the oldest unleased pending job.
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_pending
  ON public.ocr_jobs (priority DESC, created_at ASC)
  WHERE status = 'pending';

-- Lease expiry: workers scan for expired leases to reclaim.
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_leased_expiry
  ON public.ocr_jobs (lease_expires_at ASC)
  WHERE status = 'leased';

-- Quota lookups: recent jobs per wallet (sliding window).
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_wallet_created
  ON public.ocr_jobs (wallet, created_at DESC);

-- Quota lookups: recent jobs per trip (sliding window).
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_trip_created
  ON public.ocr_jobs (trip_id, created_at DESC)
  WHERE trip_id IS NOT NULL;

-- Lookup by receipt.
CREATE INDEX IF NOT EXISTS idx_ocr_jobs_receipt
  ON public.ocr_jobs (receipt_id);

ALTER TABLE public.ocr_jobs ENABLE ROW LEVEL SECURITY;

-- Users can see their own jobs; service role sees all.
DROP POLICY IF EXISTS ocr_jobs_select_owner ON public.ocr_jobs;
CREATE POLICY ocr_jobs_select_owner ON public.ocr_jobs
  FOR SELECT TO authenticated
  USING (wallet = public.current_wallet());

GRANT SELECT ON public.ocr_jobs TO authenticated;

-- ─── OCR results ────────────────────────────────────────────────────────────
-- Persists the full OCR output: raw text, confidence, provenance (engine,
-- version, duration), and the parsed draft fields. This row is what the
-- client polls for after upload.
CREATE TABLE IF NOT EXISTS public.ocr_results (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id           UUID        NOT NULL REFERENCES public.ocr_jobs (id) ON DELETE CASCADE,
  receipt_id       UUID        NOT NULL REFERENCES public.expense_receipts (id) ON DELETE CASCADE,
  -- Raw OCR output
  raw_text         TEXT,
  confidence       REAL        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  -- Parsed fields (the receipt draft)
  parsed_fields    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  line_items       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  -- Provenance: how the result was produced
  engine           TEXT        NOT NULL DEFAULT 'tesseract.js',
  engine_version   TEXT,
  worker_id        TEXT,
  processing_ms    INT,
  -- Review tracking
  reviewed         BOOLEAN     NOT NULL DEFAULT FALSE,
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      TEXT,
  -- Timestamps
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_ocr_results_receipt
  ON public.ocr_results (receipt_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ocr_results_job
  ON public.ocr_results (job_id);

ALTER TABLE public.ocr_results ENABLE ROW LEVEL SECURITY;

-- Users can see results for their own jobs.
DROP POLICY IF EXISTS ocr_results_select_owner ON public.ocr_results;
CREATE POLICY ocr_results_select_owner ON public.ocr_results
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.ocr_jobs j
      WHERE j.id = ocr_results.job_id
        AND j.wallet = public.current_wallet()
    )
  );

GRANT SELECT ON public.ocr_results TO authenticated;

-- ─── Quota configuration ────────────────────────────────────────────────────
-- Stored in a table so it can be tuned without redeployment. Only the service
-- role writes these; authenticated users read their own applicable limits.
CREATE TABLE IF NOT EXISTS public.ocr_quota_config (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope            TEXT        NOT NULL CHECK (scope IN ('global', 'user', 'trip')),
  max_jobs         INT         NOT NULL CHECK (max_jobs > 0),
  window_seconds   INT         NOT NULL CHECK (window_seconds > 0),
  max_file_bytes   INT         NOT NULL DEFAULT 4194304 CHECK (max_file_bytes > 0),
  max_concurrent   INT         NOT NULL DEFAULT 2 CHECK (max_concurrent > 0),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.ocr_quota_config ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ocr_quota_config_select ON public.ocr_quota_config;
CREATE POLICY ocr_quota_config_select ON public.ocr_quota_config
  FOR SELECT TO authenticated USING (true);

GRANT SELECT ON public.ocr_quota_config TO authenticated;

-- Seed default quotas: 20 OCR jobs/hour per user, 50/hour per trip.
INSERT INTO public.ocr_quota_config (scope, max_jobs, window_seconds)
VALUES ('user', 20, 3600), ('trip', 50, 3600)
ON CONFLICT DO NOTHING;

-- ─── Claim function ─────────────────────────────────────────────────────────
-- Atomic lease: a worker claims the next available job. The SELECT … FOR
-- UPDATE SKIP LOCKED pattern means concurrent workers never fight over the
-- same row. Returns at most one row; empty set means nothing to do.
CREATE OR REPLACE FUNCTION public.claim_ocr_job(
  p_worker_id      TEXT,
  p_lease_seconds  INT DEFAULT 90
)
RETURNS SETOF public.ocr_jobs
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_job_id UUID;
BEGIN
  -- First, reclaim any expired leases.
  UPDATE public.ocr_jobs
     SET status = 'pending', leased_at = NULL, leased_by = NULL, lease_expires_at = NULL
   WHERE status = 'leased' AND lease_expires_at < NOW();

  -- Claim the highest-priority, oldest pending job.
  SELECT id INTO v_job_id
    FROM public.ocr_jobs
   WHERE status = 'pending'
     AND attempts < max_attempts
   ORDER BY priority DESC, created_at ASC
   LIMIT 1
   FOR UPDATE SKIP LOCKED;

  IF v_job_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.ocr_jobs
     SET status = 'leased',
         leased_at = NOW(),
         leased_by = p_worker_id,
         lease_expires_at = NOW() + (p_lease_seconds || ' seconds')::INTERVAL,
         attempts = attempts + 1,
         started_at = COALESCE(started_at, NOW())
   WHERE id = v_job_id;

  RETURN QUERY SELECT * FROM public.ocr_jobs WHERE id = v_job_id;
END;
$fn$;

-- ─── Complete function ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.complete_ocr_job(
  p_job_id  UUID,
  p_status  TEXT,
  p_error   TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF p_status NOT IN ('completed', 'failed') THEN
    RAISE EXCEPTION 'Invalid completion status: %', p_status;
  END IF;

  UPDATE public.ocr_jobs
     SET status = p_status,
         completed_at = NOW(),
         last_error = p_error,
         leased_at = NULL,
         lease_expires_at = NULL
   WHERE id = p_job_id;
END;
$fn$;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0029', '0029_ocr_queue_and_quotas', 'ocr_queue_quotas_v1')
ON CONFLICT (version) DO NOTHING;
