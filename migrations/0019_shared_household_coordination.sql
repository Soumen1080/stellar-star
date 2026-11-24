-- Shared household coordination is a trip-scoped prototype. Chores and their
-- history are separate from expenses, shares, payments, and settlement.

ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS household_coordination_enabled BOOLEAN NOT NULL DEFAULT FALSE;

CREATE TABLE IF NOT EXISTS public.household_chores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  title TEXT NOT NULL CHECK (length(btrim(title)) BETWEEN 1 AND 120),
  details TEXT CHECK (details IS NULL OR length(details) <= 500),
  cadence TEXT NOT NULL CHECK (cadence IN ('weekly', 'biweekly', 'monthly')),
  rotation_wallets TEXT[] NOT NULL CHECK (cardinality(rotation_wallets) > 0),
  rotation_cursor INTEGER NOT NULL DEFAULT 0 CHECK (rotation_cursor >= 0),
  CHECK (rotation_cursor < cardinality(rotation_wallets)),
  next_due_on DATE NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_by_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS household_chores_trip_active_due_idx
  ON public.household_chores (trip_id, active, next_due_on);

DROP TRIGGER IF EXISTS trg_016_household_chores_updated_at ON public.household_chores;
CREATE TRIGGER trg_016_household_chores_updated_at
  BEFORE UPDATE ON public.household_chores
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TABLE IF NOT EXISTS public.household_chore_completions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chore_id UUID NOT NULL REFERENCES public.household_chores(id) ON DELETE CASCADE,
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  completed_by_wallet TEXT NOT NULL,
  due_on DATE NOT NULL,
  supply_expense_id UUID REFERENCES public.expenses(id) ON DELETE SET NULL,
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (chore_id, due_on)
);

CREATE INDEX IF NOT EXISTS household_chore_completions_trip_completed_idx
  ON public.household_chore_completions (trip_id, completed_at DESC);

CREATE TABLE IF NOT EXISTS public.household_chore_preferences (
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  opted_out BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trip_id, wallet_address)
);

CREATE OR REPLACE FUNCTION public.guard_household_coordination_setting()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
BEGIN
  IF NEW.household_coordination_enabled IS DISTINCT FROM OLD.household_coordination_enabled
     AND public.trip_member_role(OLD.id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'HOUSEHOLD_COORDINATION_OWNER_ONLY' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_016_household_coordination_owner ON public.trips;
CREATE TRIGGER trg_016_household_coordination_owner
  BEFORE UPDATE OF household_coordination_enabled ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_household_coordination_setting();

CREATE OR REPLACE FUNCTION public.complete_household_chore(
  p_chore_id UUID,
  p_due_on DATE,
  p_supply_expense_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_chore public.household_chores%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_wallet TEXT := public.current_wallet();
  v_assignee TEXT;
  v_rotation_index INTEGER;
  v_offset INTEGER;
  v_completion_id UUID;
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'HOUSEHOLD_AUTH_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_chore
  FROM public.household_chores
  WHERE id = p_chore_id AND active
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'HOUSEHOLD_CHORE_NOT_FOUND'; END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = v_chore.trip_id FOR UPDATE;
  IF NOT FOUND OR NOT v_trip.household_coordination_enabled
     OR NOT (v_trip.member_wallets @> ARRAY[v_wallet]) THEN
    RAISE EXCEPTION 'HOUSEHOLD_MODULE_UNAVAILABLE' USING ERRCODE = '42501';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.household_chore_completions
    WHERE chore_id = v_chore.id AND due_on = p_due_on
  ) THEN
    SELECT id INTO v_completion_id
    FROM public.household_chore_completions
    WHERE chore_id = v_chore.id AND due_on = p_due_on;
    RETURN v_completion_id;
  END IF;

  IF p_due_on IS DISTINCT FROM v_chore.next_due_on THEN
    RAISE EXCEPTION 'HOUSEHOLD_CHORE_NOT_DUE';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.household_chore_preferences
    WHERE trip_id = v_chore.trip_id
      AND upper(wallet_address) = upper(v_wallet)
      AND opted_out
  ) THEN
    RAISE EXCEPTION 'HOUSEHOLD_MEMBER_OPTED_OUT' USING ERRCODE = '42501';
  END IF;

  IF p_supply_expense_id IS NOT NULL AND NOT (
    v_trip.expense_ids @> ARRAY[p_supply_expense_id::TEXT]
    AND EXISTS (SELECT 1 FROM public.expenses WHERE id = p_supply_expense_id)
  ) THEN
    RAISE EXCEPTION 'HOUSEHOLD_EXPENSE_NOT_IN_TRIP';
  END IF;

  FOR v_offset IN 0..cardinality(v_chore.rotation_wallets) - 1 LOOP
    v_rotation_index := (v_chore.rotation_cursor + v_offset)
      % cardinality(v_chore.rotation_wallets);
    v_assignee := v_chore.rotation_wallets[v_rotation_index + 1];
    IF EXISTS (
      SELECT 1 FROM unnest(v_trip.member_wallets) member_wallet
      WHERE upper(member_wallet) = upper(v_assignee)
    ) AND NOT EXISTS (
      SELECT 1 FROM public.household_chore_preferences preference
      WHERE preference.trip_id = v_chore.trip_id
        AND upper(preference.wallet_address) = upper(v_assignee)
        AND preference.opted_out
    ) THEN
      EXIT;
    END IF;
    v_assignee := NULL;
  END LOOP;

  IF v_assignee IS NULL THEN RAISE EXCEPTION 'HOUSEHOLD_NO_ELIGIBLE_ASSIGNEE'; END IF;
  IF upper(v_assignee) <> upper(v_wallet) THEN
    RAISE EXCEPTION 'HOUSEHOLD_CHORE_ASSIGNED_TO_ANOTHER_MEMBER' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.household_chore_completions (
    chore_id, trip_id, completed_by_wallet, due_on, supply_expense_id
  ) VALUES (
    v_chore.id, v_chore.trip_id, v_wallet, p_due_on, p_supply_expense_id
  )
  ON CONFLICT (chore_id, due_on) DO NOTHING
  RETURNING id INTO v_completion_id;

  IF v_completion_id IS NOT NULL THEN
    UPDATE public.household_chores
    SET rotation_cursor = (v_rotation_index + 1) % cardinality(v_chore.rotation_wallets),
        next_due_on = CASE v_chore.cadence
          WHEN 'weekly' THEN p_due_on + 7
          WHEN 'biweekly' THEN p_due_on + 14
          ELSE (p_due_on + INTERVAL '1 month')::DATE
        END
    WHERE id = v_chore.id;
  ELSE
    SELECT id INTO v_completion_id
    FROM public.household_chore_completions
    WHERE chore_id = v_chore.id AND due_on = p_due_on;
  END IF;

  RETURN v_completion_id;
END;
$fn$;

ALTER TABLE public.household_chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_chore_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_chore_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS household_chores_select_members ON public.household_chores;
CREATE POLICY household_chores_select_members ON public.household_chores
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips trip
    WHERE trip.id = household_chores.trip_id
      AND trip.household_coordination_enabled
      AND trip.member_wallets @> ARRAY[public.current_wallet()]
  ));

DROP POLICY IF EXISTS household_chores_insert_members ON public.household_chores;
CREATE POLICY household_chores_insert_members ON public.household_chores
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by_wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chores.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
    AND NOT EXISTS (
      SELECT 1
      FROM unnest(household_chores.rotation_wallets) rotation_wallet
      WHERE NOT EXISTS (
        SELECT 1 FROM public.trips trip
        WHERE trip.id = household_chores.trip_id
          AND trip.member_wallets @> ARRAY[rotation_wallet]
      )
    )
  );

DROP POLICY IF EXISTS household_chores_update_creators ON public.household_chores;
CREATE POLICY household_chores_update_creators ON public.household_chores
  FOR UPDATE TO authenticated
  USING (
    created_by_wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chores.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  )
  WITH CHECK (
    created_by_wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chores.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

DROP POLICY IF EXISTS household_chores_delete_creators ON public.household_chores;

DROP POLICY IF EXISTS household_chore_completions_select_members ON public.household_chore_completions;
CREATE POLICY household_chore_completions_select_members ON public.household_chore_completions
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips trip
    WHERE trip.id = household_chore_completions.trip_id
      AND trip.household_coordination_enabled
      AND trip.member_wallets @> ARRAY[public.current_wallet()]
  ));

DROP POLICY IF EXISTS household_chore_preferences_select_members ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_select_members ON public.household_chore_preferences
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chore_preferences.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

DROP POLICY IF EXISTS household_chore_preferences_insert_self ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_insert_self ON public.household_chore_preferences
  FOR INSERT TO authenticated
  WITH CHECK (
    upper(wallet_address) = upper(public.current_wallet())
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chore_preferences.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

DROP POLICY IF EXISTS household_chore_preferences_update_self ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_update_self ON public.household_chore_preferences
  FOR UPDATE TO authenticated
  USING (
    upper(wallet_address) = upper(public.current_wallet())
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chore_preferences.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  )
  WITH CHECK (
    upper(wallet_address) = upper(public.current_wallet())
    AND EXISTS (
      SELECT 1 FROM public.trips trip
      WHERE trip.id = household_chore_preferences.trip_id
        AND trip.household_coordination_enabled
        AND trip.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

GRANT SELECT, INSERT ON public.household_chores TO authenticated;
GRANT UPDATE (active) ON public.household_chores TO authenticated;
GRANT SELECT ON public.household_chore_completions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.household_chore_preferences TO authenticated;
REVOKE ALL ON FUNCTION public.complete_household_chore(UUID, DATE, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_household_chore(UUID, DATE, UUID) TO authenticated;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'household_chores'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chores;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
        AND tablename = 'household_chore_completions'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chore_completions;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_publication_tables
      WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
        AND tablename = 'household_chore_preferences'
    ) THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chore_preferences;
    END IF;
  END IF;
END;
$publication$;
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_shared_household_coordination', 'household_coordination_v1')
ON CONFLICT (version) DO NOTHING;
