-- ============================================================================
-- 0007 — Composite indexes for dashboard and settlement query paths
-- ============================================================================
-- The application stores trip membership in trips.member_wallets and links
-- expenses through trips.expense_ids; there is no expenses.trip_id or separate
-- trip_members table. These indexes therefore follow the columns the live
-- query layer actually filters and orders by.

-- Dashboard filters followed by newest-first ordering.
CREATE INDEX IF NOT EXISTS idx_expenses_creator_created_at
  ON public.expenses (created_by_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_settled_created_at
  ON public.expenses (settled, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_creator_created_at
  ON public.trips (created_by_wallet, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_settled_created_at
  ON public.trips (settled, created_at DESC);

-- fetchTripInvites: WHERE trip_id = ? ORDER BY created_at DESC.
CREATE INDEX IF NOT EXISTS idx_trip_invites_trip_created_at
  ON public.trip_invites (trip_id, created_at DESC);

-- fetchActiveSettlementIntents: wallet equality + status set + newest first.
CREATE INDEX IF NOT EXISTS settlement_intents_member_status_created_at_idx
  ON public.settlement_intents (member_wallet, status, created_at DESC);

-- record_auth_challenge counts an address and evicts its oldest challenge.
CREATE INDEX IF NOT EXISTS auth_challenges_address_created_at_idx
  ON public.auth_challenges (address, created_at ASC);

-- The GIN member_wallets indexes only support the containment operator. The
-- baseline migration used `current_wallet() = ANY(member_wallets)`, making the
-- index invisible to the planner on migration-provisioned databases. Align the
-- policies with the cumulative setup schema's indexable expression.
DROP POLICY IF EXISTS expenses_select_member ON public.expenses;
DROP POLICY IF EXISTS expenses_select_members ON public.expenses;
CREATE POLICY expenses_select_members ON public.expenses
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  );

DROP POLICY IF EXISTS expenses_update_member ON public.expenses;
DROP POLICY IF EXISTS expenses_update_members ON public.expenses;
CREATE POLICY expenses_update_members ON public.expenses
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  );

DROP POLICY IF EXISTS trips_select_member ON public.trips;
DROP POLICY IF EXISTS trips_select_members ON public.trips;
CREATE POLICY trips_select_members ON public.trips
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  );

DROP POLICY IF EXISTS trips_update_member ON public.trips;
DROP POLICY IF EXISTS trips_update_members ON public.trips;
CREATE POLICY trips_update_members ON public.trips
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND member_wallets @> ARRAY[public.current_wallet()]
  );

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0007', '0007_composite_query_indexes', 'composite_query_indexes_v1')
ON CONFLICT (version) DO NOTHING;
