-- ============================================================================
-- Migration 0026: Leased reconciliation queue (#416)
-- ============================================================================
-- Reconciliation used to read due rows with a plain SELECT and process them
-- inside whatever HTTP request started the run. Two overlapping runs read the
-- same rows and reconciled the same payment twice, and a run killed by the
-- platform timeout left its work half done with nothing to say so.
--
-- This migration turns public.reconciliation_queue into a leased work queue:
--
--   enqueue   enqueue_reconciliation_job() inserts a job at most once per
--             dedupe key. The table is range-partitioned by created_at
--             (migration 0021), so a global UNIQUE index on the key is not
--             possible; the function serializes on a transaction-scoped
--             advisory lock for the key instead. SECURITY INVOKER, so a
--             wallet session can enqueue only its own jobs (RLS).
--   claim     claim_reconciliation_jobs() takes due jobs with
--             FOR UPDATE SKIP LOCKED and stamps each with a fresh lease token,
--             an owner and an expiry. Concurrent workers never receive the
--             same job, and a job whose lease expired (its worker died) is
--             claimable again.
--   heartbeat heartbeat_reconciliation_job() extends a lease, but only for the
--             holder of the current token.
--   finish    Every state transition the worker writes is fenced on
--             (id, lease_token). Once a lease has been re-claimed, the old
--             holder's writes match no row and are discarded.
--   retry     fail_reconciliation_job() records a processing failure, counts an
--             attempt and schedules a backoff, or moves the job to
--             'dead_letter' once max_attempts is reached.
--   poison    A job whose lease expires max_lease_recoveries times without
--             being finished is dead-lettered instead of handed out again.
--   requeue   requeue_reconciliation_job() lets staff return a dead-lettered
--             job to the state it was in when it was dead-lettered.
--
-- Worker RPCs are SECURITY DEFINER and executable by service_role only.
-- Wallet sessions keep SELECT and INSERT (own rows, by RLS) but lose UPDATE.
-- Lease fields only work if no party can rewrite them, and since #415 every
-- worker write goes through the service role.
--
-- Index / plan analysis (query-plan fixture:
--   __tests__/database/fixtures/reconciliationQueuePlan.fixture.json):
--   - Claim:       Index Scan on idx_reconciliation_queue_claimable per
--                  partition (Merge Append ordered by next_attempt_at), LockRows
--                  with SKIP LOCKED. Terminal rows (recorded/escalated/failed/
--                  dead_letter) are not in the partial index, so backlog size
--                  and not history size sets the cost of a claim.
--   - Lease sweep: Index Scan on idx_reconciliation_queue_lease_expiry, which
--                  only holds rows that currently have a lease.
--   - Dedupe:      Index Scan on idx_reconciliation_queue_dedupe_key.
--   - Dead letter: Index Scan on idx_reconciliation_queue_dead_letter.
--
-- Rollback:
--   Stop the cron route first. Then:
--     DROP FUNCTION IF EXISTS public.claim_reconciliation_jobs(TEXT, INT, INT);
--     DROP FUNCTION IF EXISTS public.heartbeat_reconciliation_job(UUID, UUID, INT);
--     DROP FUNCTION IF EXISTS public.fail_reconciliation_job(UUID, UUID, TEXT, INT);
--     DROP FUNCTION IF EXISTS public.release_reconciliation_job(UUID, UUID);
--     DROP FUNCTION IF EXISTS public.requeue_reconciliation_job(UUID);
--     DROP FUNCTION IF EXISTS public.enqueue_reconciliation_job(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, INT, INT);
--     UPDATE public.reconciliation_queue
--        SET status = COALESCE(dead_lettered_from, 'failed')
--      WHERE status = 'dead_letter';
--   and restore the 0021 status CHECK. The added columns are nullable or
--   defaulted and can stay. Re-grant UPDATE to authenticated only together
--   with the reconciliation_queue_update_parties policy from 0020.
-- ============================================================================

-- ─── 1. Lease, dedupe and dead-letter columns ────────────────────────────────

ALTER TABLE public.reconciliation_queue
  ADD COLUMN IF NOT EXISTS dedupe_key            TEXT,
  ADD COLUMN IF NOT EXISTS lease_owner           TEXT,
  ADD COLUMN IF NOT EXISTS lease_token           UUID,
  ADD COLUMN IF NOT EXISTS leased_at             TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS lease_expires_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS heartbeat_at          TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS claim_count           INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_recoveries      INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS max_lease_recoveries  INT NOT NULL DEFAULT 3,
  ADD COLUMN IF NOT EXISTS dead_lettered_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dead_lettered_from    TEXT,
  ADD COLUMN IF NOT EXISTS dead_letter_reason    TEXT;

ALTER TABLE public.reconciliation_queue
  DROP CONSTRAINT IF EXISTS reconciliation_queue_status_check;
ALTER TABLE public.reconciliation_queue
  ADD CONSTRAINT reconciliation_queue_status_check CHECK (status IN (
    'not_submitted',
    'submitted_not_confirmed',
    'confirmed_not_recorded',
    'recorded',
    'escalated',
    'failed',
    'dead_letter'
  ));

-- A lease is all-or-nothing: token, owner and expiry are set together.
ALTER TABLE public.reconciliation_queue
  DROP CONSTRAINT IF EXISTS reconciliation_queue_lease_shape;
ALTER TABLE public.reconciliation_queue
  ADD CONSTRAINT reconciliation_queue_lease_shape CHECK (
    (lease_token IS NULL AND lease_owner IS NULL AND lease_expires_at IS NULL)
    OR (lease_token IS NOT NULL AND lease_owner IS NOT NULL AND lease_expires_at IS NOT NULL)
  );

ALTER TABLE public.reconciliation_queue
  DROP CONSTRAINT IF EXISTS reconciliation_queue_counters_check;
ALTER TABLE public.reconciliation_queue
  ADD CONSTRAINT reconciliation_queue_counters_check CHECK (
    attempts >= 0 AND max_attempts >= 1
    AND claim_count >= 0 AND lease_recoveries >= 0 AND max_lease_recoveries >= 1
  );

-- Existing intent-linked jobs get the same key enqueue_reconciliation_job()
-- would give them, newest row per intent, so a re-sync cannot add another job.
UPDATE public.reconciliation_queue q
   SET dedupe_key = 'intent:' || q.intent_id::TEXT
  FROM (
    SELECT DISTINCT ON (intent_id) id, created_at
      FROM public.reconciliation_queue
     WHERE intent_id IS NOT NULL
     ORDER BY intent_id, created_at DESC
  ) newest
 WHERE q.id = newest.id
   AND q.created_at = newest.created_at
   AND q.dedupe_key IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM public.reconciliation_queue other
      WHERE other.dedupe_key = 'intent:' || q.intent_id::TEXT
   );

-- Run log (0025): which lease owner a run used, and what it lost or parked.
ALTER TABLE public.reconciliation_worker_runs
  ADD COLUMN IF NOT EXISTS worker_id     TEXT,
  ADD COLUMN IF NOT EXISTS dead_lettered INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS lease_lost    INT NOT NULL DEFAULT 0;

-- ─── 2. Indexes ──────────────────────────────────────────────────────────────

-- Claims: only live jobs, in claim order.
CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_claimable
  ON public.reconciliation_queue (next_attempt_at, created_at)
  WHERE status IN ('not_submitted', 'submitted_not_confirmed', 'confirmed_not_recorded');

-- Lease recovery and poison-job sweep: only rows that currently hold a lease.
CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_lease_expiry
  ON public.reconciliation_queue (lease_expires_at)
  WHERE lease_token IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_dedupe_key
  ON public.reconciliation_queue (dedupe_key)
  WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_dead_letter
  ON public.reconciliation_queue (dead_lettered_at DESC)
  WHERE status = 'dead_letter';

-- ─── 3. Access: wallets read and enqueue; only the service role transitions ──

DROP POLICY IF EXISTS reconciliation_queue_update_parties ON public.reconciliation_queue;
REVOKE UPDATE, DELETE ON public.reconciliation_queue FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.reconciliation_queue TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reconciliation_queue TO service_role;

-- ─── 4. Enqueue (at most once per dedupe key) ────────────────────────────────

CREATE OR REPLACE FUNCTION public.enqueue_reconciliation_job(
  p_dedupe_key     TEXT,
  p_intent_id      UUID,
  p_trip_id        TEXT,
  p_expense_id     TEXT,
  p_member_id      TEXT,
  p_payer_wallet   TEXT,
  p_member_wallet  TEXT,
  p_asset          TEXT,
  p_amount         TEXT,
  p_amount_stroops NUMERIC,
  p_expected_memo  TEXT DEFAULT NULL,
  p_request_id     TEXT DEFAULT NULL,
  p_tx_hash        TEXT DEFAULT NULL,
  p_max_attempts   INT DEFAULT 10,
  p_backoff_ms     INT DEFAULT 5000
)
RETURNS SETOF public.reconciliation_queue
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_key TEXT := btrim(COALESCE(p_dedupe_key, ''));
BEGIN
  IF v_key = '' OR length(v_key) > 200 THEN
    RAISE EXCEPTION 'RECONCILIATION_DEDUPE_KEY_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Held until commit: a concurrent enqueue of the same key waits here and
  -- then sees this transaction's row in the check below.
  PERFORM pg_advisory_xact_lock(hashtextextended('reconciliation_queue:' || v_key, 0));

  RETURN QUERY
    SELECT q.* FROM public.reconciliation_queue q
     WHERE q.dedupe_key = v_key
     ORDER BY q.created_at DESC
     LIMIT 1;
  IF FOUND THEN
    RETURN;
  END IF;

  RETURN QUERY
    INSERT INTO public.reconciliation_queue (
      dedupe_key, intent_id, trip_id, expense_id, member_id, payer_wallet,
      member_wallet, asset, amount, amount_stroops, expected_memo, request_id,
      tx_hash, status, attempts, max_attempts, backoff_ms, next_attempt_at
    ) VALUES (
      v_key, p_intent_id, p_trip_id, p_expense_id, p_member_id, p_payer_wallet,
      p_member_wallet, COALESCE(NULLIF(btrim(p_asset), ''), 'XLM'), p_amount,
      p_amount_stroops, p_expected_memo, p_request_id, NULLIF(lower(btrim(p_tx_hash)), ''),
      CASE WHEN NULLIF(btrim(p_tx_hash), '') IS NULL THEN 'not_submitted' ELSE 'submitted_not_confirmed' END,
      0,
      LEAST(GREATEST(COALESCE(p_max_attempts, 10), 1), 50),
      LEAST(GREATEST(COALESCE(p_backoff_ms, 5000), 1000), 300000),
      NOW()
    )
    RETURNING *;
END;
$fn$;

-- ─── 5. Claim (SKIP LOCKED) ──────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_reconciliation_jobs(
  p_worker_id     TEXT,
  p_batch_size    INT DEFAULT 15,
  p_lease_seconds INT DEFAULT 90
)
RETURNS SETOF public.reconciliation_queue
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_batch INT := LEAST(GREATEST(COALESCE(p_batch_size, 15), 1), 50);
  v_lease INT := LEAST(GREATEST(COALESCE(p_lease_seconds, 90), 15), 900);
BEGIN
  IF p_worker_id IS NULL OR btrim(p_worker_id) = '' OR length(p_worker_id) > 128 THEN
    RAISE EXCEPTION 'RECONCILIATION_WORKER_ID_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Poison jobs: the lease has expired again and recoveries are used up, so
  -- this job keeps outliving or killing its worker. Park it for an operator.
  UPDATE public.reconciliation_queue q
     SET dead_lettered_from = q.status,
         status             = 'dead_letter',
         dead_lettered_at   = NOW(),
         dead_letter_reason = 'LEASE_EXPIRED_REPEATEDLY',
         lease_owner        = NULL,
         lease_token        = NULL,
         lease_expires_at   = NULL
    FROM (
      SELECT id, created_at
        FROM public.reconciliation_queue
       WHERE lease_token IS NOT NULL
         AND lease_expires_at < NOW()
         AND lease_recoveries >= max_lease_recoveries
         AND status IN ('not_submitted', 'submitted_not_confirmed', 'confirmed_not_recorded')
       FOR UPDATE SKIP LOCKED
    ) poison
   WHERE q.id = poison.id
     AND q.created_at = poison.created_at;

  RETURN QUERY
  WITH claimable AS (
    SELECT id, created_at
      FROM public.reconciliation_queue
     WHERE status IN ('not_submitted', 'submitted_not_confirmed', 'confirmed_not_recorded')
       AND next_attempt_at <= NOW()
       AND (lease_token IS NULL OR lease_expires_at < NOW())
     ORDER BY next_attempt_at, created_at
     LIMIT v_batch
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.reconciliation_queue q
     SET lease_owner      = p_worker_id,
         lease_token      = gen_random_uuid(),
         leased_at        = NOW(),
         lease_expires_at = NOW() + make_interval(secs => v_lease),
         heartbeat_at     = NOW(),
         claim_count      = q.claim_count + 1,
         -- q.lease_token is the pre-update value: set means the previous
         -- holder's lease expired, i.e. this claim is a recovery.
         lease_recoveries = q.lease_recoveries + CASE WHEN q.lease_token IS NULL THEN 0 ELSE 1 END
    FROM claimable c
   WHERE q.id = c.id
     AND q.created_at = c.created_at
  RETURNING q.*;
END;
$fn$;

-- ─── 6. Heartbeat (extend own lease) ─────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.heartbeat_reconciliation_job(
  p_id            UUID,
  p_lease_token   UUID,
  p_lease_seconds INT DEFAULT 90
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_lease INT := LEAST(GREATEST(COALESCE(p_lease_seconds, 90), 15), 900);
  v_rows  INT;
BEGIN
  UPDATE public.reconciliation_queue
     SET lease_expires_at = NOW() + make_interval(secs => v_lease),
         heartbeat_at     = NOW()
   WHERE id = p_id
     AND lease_token = p_lease_token
     AND status IN ('not_submitted', 'submitted_not_confirmed', 'confirmed_not_recorded');
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;

-- ─── 7. Failure: backoff, or dead-letter when attempts are exhausted ────────

CREATE OR REPLACE FUNCTION public.fail_reconciliation_job(
  p_id          UUID,
  p_lease_token UUID,
  p_error_code  TEXT,
  p_backoff_ms  INT DEFAULT 5000
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  -- Stable codes only; free-form error text is not stored (#415).
  v_code    TEXT := left(regexp_replace(COALESCE(NULLIF(btrim(p_error_code), ''), 'RECONCILIATION_JOB_FAILED'), '[^A-Za-z0-9_.:-]', '', 'g'), 120);
  v_backoff INT  := LEAST(GREATEST(COALESCE(p_backoff_ms, 5000), 0), 3600000);
  v_status  TEXT;
BEGIN
  UPDATE public.reconciliation_queue q
     SET attempts           = q.attempts + 1,
         last_attempt_at    = NOW(),
         error_message      = v_code,
         dead_lettered_from = CASE WHEN q.attempts + 1 >= q.max_attempts THEN q.status ELSE q.dead_lettered_from END,
         status             = CASE WHEN q.attempts + 1 >= q.max_attempts THEN 'dead_letter' ELSE q.status END,
         dead_lettered_at   = CASE WHEN q.attempts + 1 >= q.max_attempts THEN NOW() ELSE q.dead_lettered_at END,
         dead_letter_reason = CASE WHEN q.attempts + 1 >= q.max_attempts THEN v_code ELSE q.dead_letter_reason END,
         next_attempt_at    = NOW() + make_interval(secs => v_backoff / 1000.0),
         lease_owner        = NULL,
         lease_token        = NULL,
         lease_expires_at   = NULL
   WHERE q.id = p_id
     AND q.lease_token = p_lease_token
  RETURNING q.status INTO v_status;

  IF NOT FOUND THEN
    RETURN 'lease_lost';
  END IF;
  RETURN CASE WHEN v_status = 'dead_letter' THEN 'dead_letter' ELSE 'retry' END;
END;
$fn$;

-- ─── 8. Release an unprocessed claim (no attempt consumed) ──────────────────

CREATE OR REPLACE FUNCTION public.release_reconciliation_job(
  p_id          UUID,
  p_lease_token UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows INT;
BEGIN
  UPDATE public.reconciliation_queue
     SET lease_owner      = NULL,
         lease_token      = NULL,
         lease_expires_at = NULL
   WHERE id = p_id
     AND lease_token = p_lease_token;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;

-- ─── 9. Requeue a dead-lettered job (staff) ──────────────────────────────────

CREATE OR REPLACE FUNCTION public.requeue_reconciliation_job(p_id UUID)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_rows INT;
BEGIN
  UPDATE public.reconciliation_queue
     SET status = COALESCE(
           dead_lettered_from,
           CASE
             WHEN tx_hash IS NULL THEN 'not_submitted'
             WHEN verified_at IS NOT NULL THEN 'confirmed_not_recorded'
             ELSE 'submitted_not_confirmed'
           END
         ),
         attempts           = 0,
         lease_recoveries   = 0,
         next_attempt_at    = NOW(),
         dead_lettered_at   = NULL,
         dead_lettered_from = NULL,
         dead_letter_reason = NULL,
         error_message      = NULL
   WHERE id = p_id
     AND status = 'dead_letter'
     AND lease_token IS NULL;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows = 1;
END;
$fn$;

-- ─── 10. Grants ──────────────────────────────────────────────────────────────

REVOKE ALL ON FUNCTION public.claim_reconciliation_jobs(TEXT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heartbeat_reconciliation_job(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.fail_reconciliation_job(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.release_reconciliation_job(UUID, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.requeue_reconciliation_job(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enqueue_reconciliation_job(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, INT, INT) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.claim_reconciliation_jobs(TEXT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_reconciliation_job(UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.fail_reconciliation_job(UUID, UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.release_reconciliation_job(UUID, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.requeue_reconciliation_job(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.enqueue_reconciliation_job(TEXT, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, TEXT, TEXT, TEXT, INT, INT) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0026', '0026_reconciliation_leased_queue', 'reconciliation_leased_queue_416_v1')
ON CONFLICT (version) DO NOTHING;
