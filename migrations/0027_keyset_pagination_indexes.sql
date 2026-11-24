-- ============================================================================
-- Migration 0027: Keyset pagination indexes (#449)
-- ============================================================================
-- Every large list now pages with an opaque (created_at, id) cursor:
--
--   ORDER BY created_at DESC, id DESC
--   WHERE created_at < $c OR (created_at = $c AND id < $i)
--   LIMIT $n + 1
--
-- That needs a composite index on the full sort key, so each page is an index
-- range scan that starts at the cursor rather than skipping rows. expenses
-- already has idx_expenses_created_at_id (migration 0008); this adds the trips
-- equivalent. Plans are verified by scripts/verify-query-indexes.sql.
--
-- Rollback: forward-only and non-destructive. To revert, run
--   DROP INDEX IF EXISTS public.idx_trips_created_at_id;
-- Offset readers are gone from the application, so dropping it only slows
-- deep pages; no data changes.
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_trips_created_at_id
  ON public.trips (created_at DESC, id DESC);

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0027', '0027_keyset_pagination_indexes', 'keyset_pagination_indexes_449_v1')
ON CONFLICT (version) DO NOTHING;
