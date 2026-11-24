-- ============================================================================
-- Migration 0026: Batched trip permission checks (#417)
-- ============================================================================
-- The archive export called trip_has_permission() once per trip, so a
-- 1,000-trip export made 1,000 authorization round trips before any data
-- left the database. That costs latency and database load, and checks
-- made across separate statements can see different states of the roster.
--
-- trips_with_permission(p_trip_ids, p_permission) resolves every requested
-- trip in one statement and returns only the ids the caller holds the
-- permission on. A trip that does not exist, one the caller is not a member
-- of, and one where the caller lacks the permission all look the same:
-- the id is absent. The caller cannot tell which ids exist.
--
-- RLS safety: SECURITY DEFINER, but every row is filtered on
--   member_wallets @> ARRAY[current_wallet()]
-- the trips_select_members predicate, plus the same role rules as
-- trip_has_permission() (0016). A NULL wallet (anon) gets nothing.
-- Input is capped at 1,000 ids.
--
-- Plan (fixture: __tests__/database/fixtures/batchTripPermissionsPlan.fixture.json):
--   Index Scan using trips_pkey on trips  Index Cond: (id = ANY ($1))
--   Filter: member_wallets @> ARRAY[current_wallet()]
--   -> Limit -> Function Scan on jsonb_array_elements (members of that trip only)
--   One statement for any number of ids, using the primary-key index.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.trips_with_permission(UUID[], TEXT);
--   DELETE FROM public.schema_migrations WHERE version = '0026' AND name = '0026_batch_trip_permissions';
--   The export route then fails closed (RPC missing => 500, nothing served).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.trips_with_permission(p_trip_ids UUID[], p_permission TEXT)
RETURNS SETOF UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  WITH caller AS (
    SELECT public.current_wallet() AS wallet
  )
  SELECT t.id
    FROM caller c
    JOIN public.trips t
      ON t.id = ANY (p_trip_ids)
     AND t.member_wallets @> ARRAY[c.wallet]
    CROSS JOIN LATERAL (
      SELECT
        COALESCE(
          m ->> 'role',
          CASE
            WHEN upper(btrim(m ->> 'walletAddress')) = upper(btrim(t.created_by_wallet)) THEN 'owner'
            ELSE 'contributor'
          END
        ) AS role,
        COALESCE(m -> 'customPermissions', '[]'::jsonb) AS permissions
      FROM jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) m
      WHERE upper(btrim(COALESCE(m ->> 'walletAddress', ''))) = upper(btrim(c.wallet))
      LIMIT 1
    ) r
   WHERE c.wallet IS NOT NULL
     AND cardinality(p_trip_ids) <= 1000
     AND p_permission IN (
       'trip.settings.manage', 'members.manage', 'expenses.manage',
       'receipts.manage', 'exports.view', 'reminders.manage',
       'settlement.proposals.manage'
     )
     AND (
       r.role IN ('owner', 'organizer')
       OR (r.role = 'contributor' AND p_permission IN ('expenses.manage', 'receipts.manage', 'exports.view'))
       OR (r.role = 'viewer' AND p_permission = 'exports.view')
       OR (r.role = 'custom' AND jsonb_typeof(r.permissions) = 'array' AND r.permissions ? p_permission)
     );
$fn$;

REVOKE ALL ON FUNCTION public.trips_with_permission(UUID[], TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.trips_with_permission(UUID[], TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0026', '0026_batch_trip_permissions', 'batch_trip_permissions_417_v1')
ON CONFLICT (version) DO NOTHING;
