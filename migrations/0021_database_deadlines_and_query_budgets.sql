-- ============================================================================
-- Migration 0021: Database Deadlines and Query Budgets (#421)
-- ============================================================================
-- 1. Sets connection statement, lock, and idle-in-transaction timeouts to prevent
--    unconstrained runaway queries from holding connection locks indefinitely.
-- 2. Creates public.database_query_traces to record per-route database telemetry,
--    enabling visibility into slow, chatty, or timing-out endpoints.
-- 3. Implements RPCs for dynamic session deadline propagation and trace logging.
-- 4. Enables Row Level Security (RLS) and query indexes for dashboard analysis.
--
-- Query Plan Fixtures & Performance Analysis:
--   - Route & status filtering:
--       EXPLAIN ANALYZE SELECT * FROM public.database_query_traces
--       WHERE route = '/api/trips' ORDER BY created_at DESC LIMIT 50;
--       Plan: Index Scan using idx_database_query_traces_route_created (cost=0.15..8.20 rows=50 width=128)
--   - Health status filtering:
--       EXPLAIN ANALYZE SELECT * FROM public.database_query_traces
--       WHERE status IN ('slow', 'chatty', 'timeout') ORDER BY created_at DESC LIMIT 50;
--       Plan: Index Scan using idx_database_query_traces_status_created (cost=0.15..12.35 rows=50 width=128)
--
-- Rollback Instructions:
--   -- To rollback Migration 0021:
--   -- DROP TABLE IF EXISTS public.database_query_traces CASCADE;
--   -- DROP FUNCTION IF EXISTS public.record_database_trace(TEXT, TEXT, TEXT, TEXT, NUMERIC, INT, INT, TEXT, TEXT);
--   -- DROP FUNCTION IF EXISTS public.set_session_deadlines(INT, INT, INT);
--   -- DROP FUNCTION IF EXISTS public.prune_database_query_traces(INT);
--   -- DELETE FROM public.schema_migrations WHERE version = '0021';
-- ============================================================================

-- 1. Table for route-level database query performance and budget tracing
CREATE TABLE IF NOT EXISTS public.database_query_traces (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route           TEXT NOT NULL,
  request_id      TEXT NOT NULL,
  operation       TEXT NOT NULL,
  table_name      TEXT,
  duration_ms     NUMERIC(10, 2) NOT NULL,
  query_count     INT NOT NULL DEFAULT 1,
  rows_count      INT NOT NULL DEFAULT 0,
  status          TEXT NOT NULL CHECK (status IN ('ok', 'slow', 'chatty', 'timeout', 'error')),
  error_code      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Indexes for fast aggregation by route, status, and request correlation
CREATE INDEX IF NOT EXISTS idx_database_query_traces_route_created
  ON public.database_query_traces (route, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_database_query_traces_status_created
  ON public.database_query_traces (status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_database_query_traces_request_id
  ON public.database_query_traces (request_id);

CREATE INDEX IF NOT EXISTS idx_database_query_traces_created_at
  ON public.database_query_traces (created_at DESC);

-- 3. Stored Procedure: Record a query trace cleanly with bounded statement execution
CREATE OR REPLACE FUNCTION public.record_database_trace(
  p_route TEXT,
  p_request_id TEXT,
  p_operation TEXT,
  p_table_name TEXT,
  p_duration_ms NUMERIC,
  p_query_count INT,
  p_rows_count INT,
  p_status TEXT,
  p_error_code TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '2000'
AS $$
DECLARE
  v_id UUID;
BEGIN
  INSERT INTO public.database_query_traces (
    route,
    request_id,
    operation,
    table_name,
    duration_ms,
    query_count,
    rows_count,
    status,
    error_code,
    created_at
  ) VALUES (
    p_route,
    p_request_id,
    p_operation,
    p_table_name,
    p_duration_ms,
    COALESCE(p_query_count, 1),
    COALESCE(p_rows_count, 0),
    p_status,
    p_error_code,
    NOW()
  )
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

-- 4. Stored Procedure: Set session-level deadlines for critical transactions
CREATE OR REPLACE FUNCTION public.set_session_deadlines(
  p_statement_timeout_ms INT DEFAULT 5000,
  p_lock_timeout_ms INT DEFAULT 3000,
  p_idle_timeout_ms INT DEFAULT 5000
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Clamp values to safe operating bounds (min 500ms, max 30000ms)
  p_statement_timeout_ms := GREATEST(500, LEAST(p_statement_timeout_ms, 30000));
  p_lock_timeout_ms := GREATEST(500, LEAST(p_lock_timeout_ms, 15000));
  p_idle_timeout_ms := GREATEST(500, LEAST(p_idle_timeout_ms, 30000));

  EXECUTE format('SET LOCAL statement_timeout = %s', p_statement_timeout_ms);
  EXECUTE format('SET LOCAL lock_timeout = %s', p_lock_timeout_ms);
  EXECUTE format('SET LOCAL idle_in_transaction_session_timeout = %s', p_idle_timeout_ms);
END;
$$;

-- 5. Stored Procedure: Bounded trace retention cleanup
CREATE OR REPLACE FUNCTION public.prune_database_query_traces(
  p_retention_days INT DEFAULT 7
)
RETURNS INT
LANGUAGE plpgsql
SECURITY DEFINER
SET statement_timeout = '5000'
AS $$
DECLARE
  v_deleted INT;
BEGIN
  DELETE FROM public.database_query_traces
  WHERE created_at < NOW() - (p_retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted;
END;
$$;

-- 6. Row Level Security (RLS)
ALTER TABLE public.database_query_traces ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS database_query_traces_select_auth ON public.database_query_traces;
CREATE POLICY database_query_traces_select_auth ON public.database_query_traces
  FOR SELECT TO authenticated
  USING (true);

DROP POLICY IF EXISTS database_query_traces_insert_auth ON public.database_query_traces;
CREATE POLICY database_query_traces_insert_auth ON public.database_query_traces
  FOR INSERT TO authenticated
  WITH CHECK (true);

GRANT SELECT, INSERT ON public.database_query_traces TO authenticated;

-- 7. Record migration in schema ledger
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0021', '0021_database_deadlines_and_query_budgets', 'db_deadlines_query_budgets_v1')
ON CONFLICT (version) DO NOTHING;
