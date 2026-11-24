-- ============================================================================
-- Migration 0025: Reconciliation worker run log (#415)
-- ============================================================================
-- Every reconciliation run, whether scheduled or started by staff, records who
-- ran it, under which request ID, how long it took and what it did.
-- Per-job error messages are not stored, only the IDs of jobs that errored
-- and a stable failure code.
--
-- Access: RLS is enabled with no policies, so only the service role (which
-- bypasses RLS) can read or write the log.
--
-- Rollback: the table is append-only and nothing depends on it. To retire it,
-- stop the writer and leave the table in place.

CREATE TABLE IF NOT EXISTS public.reconciliation_worker_runs (
  id               UUID PRIMARY KEY,
  request_id       TEXT NOT NULL,
  actor_kind       TEXT NOT NULL CHECK (actor_kind IN ('cron', 'staff')),
  actor_id         TEXT NOT NULL,
  trigger          TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  batch_size       INT NOT NULL CHECK (batch_size BETWEEN 1 AND 50),
  batches          INT NOT NULL CHECK (batches >= 0),
  wallet_filter    TEXT,
  started_at       TIMESTAMPTZ NOT NULL,
  finished_at      TIMESTAMPTZ NOT NULL,
  duration_ms      INT NOT NULL CHECK (duration_ms >= 0),
  outcome          TEXT NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
  processed        INT NOT NULL DEFAULT 0,
  recorded         INT NOT NULL DEFAULT 0,
  escalated        INT NOT NULL DEFAULT 0,
  pending          INT NOT NULL DEFAULT 0,
  failed           INT NOT NULL DEFAULT 0,
  error_count      INT NOT NULL DEFAULT 0,
  errored_job_ids  TEXT[] NOT NULL DEFAULT '{}',
  failure_code     TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_reconciliation_worker_runs_started_at
  ON public.reconciliation_worker_runs (started_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_worker_runs_failed
  ON public.reconciliation_worker_runs (started_at DESC)
  WHERE outcome = 'failed';

ALTER TABLE public.reconciliation_worker_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.reconciliation_worker_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON public.reconciliation_worker_runs TO service_role;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0025', '0025_reconciliation_worker_runs', 'reconciliation_worker_runs_415_v1')
ON CONFLICT (version) DO NOTHING;
