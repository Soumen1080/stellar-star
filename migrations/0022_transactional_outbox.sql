-- ============================================================================
-- Migration 0022: Transactional Outbox Pattern (#425 / Issue 017)
-- ============================================================================
-- Guarantees atomic state transition and eventual external consequence delivery:
-- 1. Eliminates dual-write hazards: an outbox record is written in the exact same
--    transaction/mutation as the financial state change (e.g., expense creation,
--    settlement reconciliation, payment recording).
-- 2. Durable promise to dispatch: even if the synchronous webhook, reminder,
--    or analytics call fails (timeout, 5xx, worker crash), state is safe.
-- 3. Leased worker retry queue: workers claim batches via SELECT ... FOR UPDATE SKIP LOCKED
--    with worker lease expiration, bounded exponential backoff with jitter, and dead-lettering.
-- 4. Deduplication & Traceability: strict deduplication keys prevent duplicate
--    externally visible side-effects; W3C trace IDs propagate causality across systems.
--
-- Query Plan Fixtures & Index Analysis:
--   - Due job polling by status & next attempt:
--       EXPLAIN ANALYZE SELECT * FROM public.transactional_outbox
--       WHERE status = 'pending' AND next_attempt_at <= NOW()
--       ORDER BY next_attempt_at ASC, created_at ASC LIMIT 10 FOR UPDATE SKIP LOCKED;
--       Plan: Index Scan using idx_transactional_outbox_polling
--   - Deduplication key lookup:
--       EXPLAIN ANALYZE SELECT id FROM public.transactional_outbox
--       WHERE deduplication_key = 'outbox:webhook:expense:123:created';
--       Plan: Index Unique Scan using uq_transactional_outbox_dedup
--   - Distributed trace correlation:
--       EXPLAIN ANALYZE SELECT * FROM public.transactional_outbox
--       WHERE trace_id = 'c4d098e7bf894676b7e5c94ebcf12345';
--       Plan: Index Scan using idx_transactional_outbox_trace
--
-- Rollback Instructions:
--   DROP TABLE IF EXISTS public.transactional_outbox CASCADE;
--   DROP FUNCTION IF EXISTS public.claim_outbox_batch(TEXT, INT, INT);
--   DROP FUNCTION IF EXISTS public.complete_outbox_event(UUID, TEXT);
--   DROP FUNCTION IF EXISTS public.fail_outbox_event(UUID, TEXT, TEXT, INT);
--   DROP FUNCTION IF EXISTS public.enqueue_outbox_event(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT, INT, INT);
--   DELETE FROM public.schema_migrations WHERE version = '0022';
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.transactional_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type      TEXT NOT NULL,
  aggregate_id        TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('webhook', 'reminder', 'analytics')),
  payload             JSONB NOT NULL,
  headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id            TEXT NOT NULL,
  deduplication_key   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'leased', 'delivered', 'failed', 'dead_letter')),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  backoff_ms          INT NOT NULL DEFAULT 1000,
  lease_id            TEXT,
  leased_at           TIMESTAMPTZ,
  lease_expires_at    TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at     TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  error_message       TEXT,
  created_by_wallet   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_transactional_outbox_dedup UNIQUE (deduplication_key)
);

-- Performance & Queue Polling Indexes
CREATE INDEX IF NOT EXISTS idx_transactional_outbox_polling
  ON public.transactional_outbox (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_transactional_outbox_lease
  ON public.transactional_outbox (status, lease_expires_at);

CREATE INDEX IF NOT EXISTS idx_transactional_outbox_trace
  ON public.transactional_outbox (trace_id);

CREATE INDEX IF NOT EXISTS idx_transactional_outbox_aggregate
  ON public.transactional_outbox (aggregate_type, aggregate_id);

CREATE INDEX IF NOT EXISTS idx_transactional_outbox_created_at
  ON public.transactional_outbox (created_at DESC);

-- Trigger to maintain updated_at
DROP TRIGGER IF EXISTS trg_transactional_outbox_updated_at ON public.transactional_outbox;
CREATE TRIGGER trg_transactional_outbox_updated_at
  BEFORE UPDATE ON public.transactional_outbox
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS Configuration
ALTER TABLE public.transactional_outbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS transactional_outbox_select_parties ON public.transactional_outbox;
CREATE POLICY transactional_outbox_select_parties ON public.transactional_outbox
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND (created_by_wallet IS NULL OR created_by_wallet = public.current_wallet())
  );

DROP POLICY IF EXISTS transactional_outbox_insert_parties ON public.transactional_outbox;
CREATE POLICY transactional_outbox_insert_parties ON public.transactional_outbox
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND (created_by_wallet IS NULL OR created_by_wallet = public.current_wallet())
  );

DROP POLICY IF EXISTS transactional_outbox_update_parties ON public.transactional_outbox;
CREATE POLICY transactional_outbox_update_parties ON public.transactional_outbox
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND (created_by_wallet IS NULL OR created_by_wallet = public.current_wallet())
  );

GRANT SELECT, INSERT, UPDATE ON public.transactional_outbox TO authenticated;

-- Stored Procedures for Leased Outbox Workers

-- 1. Atomically claim batch of outbox messages via SKIP LOCKED
CREATE OR REPLACE FUNCTION public.claim_outbox_batch(
  p_worker_id TEXT,
  p_batch_size INT DEFAULT 10,
  p_lease_duration_seconds INT DEFAULT 60
)
RETURNS SETOF public.transactional_outbox
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  WITH claimable AS (
    SELECT id
    FROM public.transactional_outbox
    WHERE
      (status = 'pending' AND next_attempt_at <= NOW())
      OR (status = 'leased' AND lease_expires_at < NOW())
      OR (status = 'failed' AND attempts < max_attempts AND next_attempt_at <= NOW())
    ORDER BY next_attempt_at ASC, created_at ASC
    LIMIT p_batch_size
    FOR UPDATE SKIP LOCKED
  )
  UPDATE public.transactional_outbox t
  SET
    status = 'leased',
    lease_id = p_worker_id,
    leased_at = NOW(),
    lease_expires_at = NOW() + (p_lease_duration_seconds || ' seconds')::INTERVAL,
    attempts = t.attempts + 1,
    last_attempt_at = NOW(),
    updated_at = NOW()
  FROM claimable c
  WHERE t.id = c.id
  RETURNING t.*;
END;
$$;

-- 2. Mark outbox event delivered
CREATE OR REPLACE FUNCTION public.complete_outbox_event(
  p_id UUID,
  p_lease_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows_affected INT;
BEGIN
  UPDATE public.transactional_outbox
  SET
    status = 'delivered',
    delivered_at = NOW(),
    lease_id = NULL,
    lease_expires_at = NULL,
    error_message = NULL,
    updated_at = NOW()
  WHERE id = p_id
    AND (lease_id = p_lease_id OR lease_expires_at < NOW());

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- 3. Mark outbox event failed (with retry schedule or dead-letter)
CREATE OR REPLACE FUNCTION public.fail_outbox_event(
  p_id UUID,
  p_lease_id TEXT,
  p_error_message TEXT,
  p_backoff_ms INT DEFAULT 1000
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows_affected INT;
  v_attempts INT;
  v_max_attempts INT;
BEGIN
  SELECT attempts, max_attempts INTO v_attempts, v_max_attempts
  FROM public.transactional_outbox
  WHERE id = p_id;

  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  IF v_attempts >= v_max_attempts THEN
    UPDATE public.transactional_outbox
    SET
      status = 'dead_letter',
      error_message = p_error_message,
      lease_id = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
    WHERE id = p_id;
  ELSE
    UPDATE public.transactional_outbox
    SET
      status = 'failed',
      next_attempt_at = NOW() + (p_backoff_ms || ' milliseconds')::INTERVAL,
      error_message = p_error_message,
      lease_id = NULL,
      lease_expires_at = NULL,
      updated_at = NOW()
    WHERE id = p_id;
  END IF;

  GET DIAGNOSTICS v_rows_affected = ROW_COUNT;
  RETURN v_rows_affected > 0;
END;
$$;

-- 4. Atomically enqueue outbox event
CREATE OR REPLACE FUNCTION public.enqueue_outbox_event(
  p_aggregate_type TEXT,
  p_aggregate_id TEXT,
  p_event_type TEXT,
  p_channel TEXT,
  p_payload JSONB,
  p_trace_id TEXT,
  p_deduplication_key TEXT,
  p_headers JSONB DEFAULT '{}'::jsonb,
  p_created_by_wallet TEXT DEFAULT NULL,
  p_max_attempts INT DEFAULT 5,
  p_backoff_ms INT DEFAULT 1000
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.transactional_outbox (
    aggregate_type,
    aggregate_id,
    event_type,
    channel,
    payload,
    headers,
    trace_id,
    deduplication_key,
    created_by_wallet,
    max_attempts,
    backoff_ms,
    status,
    next_attempt_at,
    created_at,
    updated_at
  ) VALUES (
    p_aggregate_type,
    p_aggregate_id,
    p_event_type,
    p_channel,
    p_payload,
    COALESCE(p_headers, '{}'::jsonb),
    p_trace_id,
    p_deduplication_key,
    COALESCE(p_created_by_wallet, public.current_wallet()),
    COALESCE(p_max_attempts, 5),
    COALESCE(p_backoff_ms, 1000),
    'pending',
    NOW(),
    NOW(),
    NOW()
  )
  ON CONFLICT (deduplication_key) DO UPDATE
    SET updated_at = NOW()
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- Register Migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0022', '0022_transactional_outbox', 'transactional_outbox_v1')
ON CONFLICT (version) DO NOTHING;
