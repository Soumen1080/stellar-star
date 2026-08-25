-- ============================================================================
-- Stellar-star — diagnose a "table not found in the schema cache" error
-- ============================================================================
-- Run this in: Supabase Dashboard -> SQL Editor -> New Query -> Run
--
-- It answers two questions at once:
--   1. Did supabase-setup.sql actually run in THIS project?
--   2. If so, is PostgREST's schema cache simply stale?
--
-- The expected project ref for this app is:  gqdmiykjnzfhmzjcoser
-- Check the ref in your browser's address bar:
--   https://supabase.com/dashboard/project/<THIS-IS-THE-REF>/sql
-- If it does not say gqdmiykjnzfhmzjcoser, the setup script ran in the wrong
-- project — switch projects and run supabase-setup.sql again.
-- ============================================================================

-- 1. Which tables exist? Expect exactly three rows: expenses, trips, users.
SELECT
  'TABLE' AS kind,
  table_name,
  'exists' AS status
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN ('users', 'expenses', 'trips')

UNION ALL

-- 2. Can the API roles reach them? Expect SELECT/INSERT/UPDATE/DELETE
--    for both anon and authenticated on all three tables.
SELECT
  'GRANT' AS kind,
  table_name || ' -> ' || grantee AS table_name,
  string_agg(privilege_type, ',' ORDER BY privilege_type) AS status
FROM information_schema.role_table_grants
WHERE table_schema = 'public'
  AND table_name IN ('users', 'expenses', 'trips')
  AND grantee IN ('anon', 'authenticated')
GROUP BY table_name, grantee

UNION ALL

-- 3. Is the identity helper installed?
SELECT
  'FUNCTION' AS kind,
  'public.current_wallet()' AS table_name,
  CASE WHEN EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'current_wallet'
  ) THEN 'exists' ELSE 'MISSING' END AS status

UNION ALL

-- 4. Are the integrity triggers installed? Expect 6 (2 per table x 3 tables,
--    plus the users updated_at trigger => 7 total across all three).
SELECT
  'TRIGGERS' AS kind,
  'on users/expenses/trips' AS table_name,
  count(*)::text AS status
FROM information_schema.triggers
WHERE trigger_schema = 'public'
  AND event_object_table IN ('users', 'expenses', 'trips')

ORDER BY kind, table_name;


-- ============================================================================
-- 5. Force PostgREST to re-read the schema.
-- ============================================================================
-- If step 1 listed all three tables but the app still reports
-- "Could not find the table 'public.users' in the schema cache", the tables are
-- real and only the API's cached view of them is stale. This clears it.

NOTIFY pgrst, 'reload schema';
