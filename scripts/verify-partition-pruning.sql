-- scripts/verify-partition-pruning.sql
-- Run after provisioning a disposable database:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-partition-pruning.sql
--
-- Validates that PostgreSQL query optimizer prunes non-targeted partitions
-- when querying operational tables by date range (#424).

BEGIN;
SET LOCAL enable_seqscan = off;

-- 1. Support Audit Logs: Scans ONLY y2026m11 partition; prunes other months
EXPLAIN (COSTS OFF)
SELECT id, query_type, results_count
  FROM public.support_audit_logs
 WHERE created_at >= '2026-11-01 00:00:00+00'
   AND created_at <  '2026-12-01 00:00:00+00'
   AND staff_identifier = 'STAFF-123'
 ORDER BY created_at DESC;

-- 2. Export Audit Events: Scans ONLY y2026m11 partition; prunes other months
EXPLAIN (COSTS OFF)
SELECT id, export_kind, byte_size, status
  FROM public.export_audit_events
 WHERE created_at >= '2026-11-01 00:00:00+00'
   AND created_at <  '2026-12-01 00:00:00+00'
   AND actor_wallet = 'GQUERYPLAN'
 ORDER BY created_at DESC;

-- 3. Reminder Events: Scans ONLY y2026m11 partition; prunes other months
EXPLAIN (COSTS OFF)
SELECT id, reminder_id, kind, channel
  FROM public.reminder_events
 WHERE created_at >= '2026-11-01 00:00:00+00'
   AND created_at <  '2026-12-01 00:00:00+00'
   AND actor_wallet = 'GQUERYPLAN'
 ORDER BY created_at DESC;

-- 4. Reconciliation Queue: Scans ONLY y2026m11 partition; prunes other months
EXPLAIN (COSTS OFF)
SELECT id, trip_id, expense_id, status, attempts
  FROM public.reconciliation_queue
 WHERE created_at >= '2026-11-01 00:00:00+00'
   AND created_at <  '2026-12-01 00:00:00+00'
   AND status = 'not_submitted'
 ORDER BY created_at DESC;

ROLLBACK;
