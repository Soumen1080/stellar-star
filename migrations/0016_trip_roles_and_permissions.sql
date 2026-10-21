-- ============================================================================
-- Stellar-star Migration 0016: Configurable trip roles and granular permissions
-- ============================================================================
-- Role assignments live beside each member in trips.members. The database
-- functions below are the source of truth for RLS and for the API RPCs.

CREATE TABLE IF NOT EXISTS public.trip_role_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL,
  previous_role TEXT NOT NULL CHECK (previous_role IN ('owner', 'organizer', 'contributor', 'viewer', 'custom')),
  next_role TEXT NOT NULL CHECK (next_role IN ('owner', 'organizer', 'contributor', 'viewer', 'custom')),
  previous_custom_permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  next_custom_permissions TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  changed_by_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS trip_role_audit_trip_created_at_idx
  ON public.trip_role_audit (trip_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.trip_member_role(p_trip_id UUID, p_wallet TEXT)
RETURNS TEXT
LANGUAGE SQL
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
  SELECT COALESCE(
    member ->> 'role',
    CASE
      WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet))
      THEN 'owner'
      ELSE 'contributor'
    END
  )
  FROM public.trips t
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
  WHERE t.id = p_trip_id
    AND upper(btrim(COALESCE(p_wallet, ''))) =
        upper(btrim(COALESCE(public.current_wallet(), '')))
    AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(COALESCE(p_wallet, '')))
  LIMIT 1;
$fn$;

CREATE OR REPLACE FUNCTION public.trip_has_permission(p_trip_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet TEXT := public.current_wallet();
  v_role TEXT;
  v_permissions JSONB;
BEGIN
  IF v_wallet IS NULL OR p_permission IS NULL OR p_permission NOT IN (
    'trip.settings.manage', 'members.manage', 'expenses.manage',
    'receipts.manage', 'exports.view', 'reminders.manage',
    'settlement.proposals.manage'
  ) THEN
    RETURN FALSE;
  END IF;

  SELECT
    COALESCE(
      member ->> 'role',
      CASE
        WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet))
        THEN 'owner'
        ELSE 'contributor'
      END
    ),
    COALESCE(member -> 'customPermissions', '[]'::jsonb)
  INTO v_role, v_permissions
  FROM public.trips t
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
  WHERE t.id = p_trip_id
    AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(v_wallet))
  LIMIT 1;

  IF v_role IN ('owner', 'organizer') THEN
    RETURN TRUE;
  ELSIF v_role = 'contributor' THEN
    RETURN p_permission IN ('expenses.manage', 'receipts.manage', 'exports.view');
  ELSIF v_role = 'viewer' THEN
    RETURN p_permission = 'exports.view';
  ELSIF v_role = 'custom' THEN
    RETURN jsonb_typeof(v_permissions) = 'array' AND v_permissions ? p_permission;
  END IF;
  RETURN FALSE;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.expense_has_permission(p_expense_id UUID, p_permission TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet TEXT := public.current_wallet();
BEGIN
  IF v_wallet IS NULL OR p_permission IS NULL THEN
    RETURN FALSE;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT]
      AND public.trip_has_permission(t.id, p_permission)
  ) THEN
    RETURN TRUE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.expenses e
    WHERE e.id = p_expense_id
      AND NOT EXISTS (
        SELECT 1 FROM public.trips t WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT]
      )
      AND (
        e.created_by_wallet = v_wallet
        OR (
          p_permission = 'receipts.manage'
          AND EXISTS (
            SELECT 1 FROM jsonb_array_elements(COALESCE(e.members, '[]'::jsonb)) member
            WHERE member ->> 'id' = e.paid_by_member_id
              AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(v_wallet))
          )
        )
      )
  );
END;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_trip_member_roles()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_member JSONB;
  v_old JSONB;
  v_result JSONB := '[]'::jsonb;
  v_role TEXT;
  v_permissions JSONB;
BEGIN
  IF jsonb_typeof(COALESCE(NEW.members, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'Trip members must be an array';
  END IF;

  FOR v_member IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) LOOP
    v_old := NULL;
    IF TG_OP = 'UPDATE' THEN
      SELECT value INTO v_old
      FROM jsonb_array_elements(COALESCE(OLD.members, '[]'::jsonb))
      WHERE value ->> 'id' = v_member ->> 'id'
      LIMIT 1;
    END IF;

    IF TG_OP = 'UPDATE'
       AND v_old IS NOT NULL
       AND current_setting('stellar_star.role_change', true) IS DISTINCT FROM 'on' THEN
      v_member := jsonb_set(
        v_member,
        '{role}',
        to_jsonb(COALESCE(
          v_old ->> 'role',
          CASE
            WHEN upper(btrim(COALESCE(v_old ->> 'walletAddress', ''))) = upper(btrim(OLD.created_by_wallet))
            THEN 'owner'
            ELSE 'contributor'
          END
        ))
      );
      v_member := (v_member - 'customPermissions') ||
        CASE WHEN v_old ? 'customPermissions'
          THEN jsonb_build_object('customPermissions', v_old -> 'customPermissions')
          ELSE '{}'::jsonb
        END;
    ELSIF TG_OP = 'UPDATE' AND v_old IS NULL THEN
      v_member := (v_member - 'customPermissions') || jsonb_build_object('role', 'contributor');
    ELSIF TG_OP = 'INSERT' THEN
      v_member := (v_member - 'customPermissions') || jsonb_build_object(
        'role',
        CASE
          WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress', ''))) = upper(btrim(NEW.created_by_wallet))
          THEN 'owner'
          ELSE 'contributor'
        END
      );
    END IF;

    v_role := COALESCE(
      v_member ->> 'role',
      CASE
        WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress', ''))) = upper(btrim(NEW.created_by_wallet))
        THEN 'owner'
        ELSE 'contributor'
      END
    );
    IF v_role NOT IN ('owner', 'organizer', 'contributor', 'viewer', 'custom') THEN
      RAISE EXCEPTION 'Invalid trip role';
    END IF;

    v_member := jsonb_set(v_member, '{role}', to_jsonb(v_role));
    v_permissions := COALESCE(v_member -> 'customPermissions', '[]'::jsonb);
    IF v_role = 'custom' THEN
      IF jsonb_typeof(v_permissions) <> 'array'
         OR EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_permissions) permission
           WHERE permission IS NULL OR permission NOT IN (
             'trip.settings.manage', 'members.manage', 'expenses.manage',
             'receipts.manage', 'exports.view', 'reminders.manage',
             'settlement.proposals.manage'
           )
         ) THEN
        RAISE EXCEPTION 'Invalid custom trip permission';
      END IF;
    ELSE
      v_member := v_member - 'customPermissions';
    END IF;

    v_result := v_result || jsonb_build_array(v_member);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_result) member
    WHERE member ->> 'role' = 'owner'
      AND btrim(COALESCE(member ->> 'walletAddress', '')) <> ''
  ) THEN
    RAISE EXCEPTION 'A trip must retain at least one owner; transfer ownership before demoting or removing the final owner';
  END IF;

  NEW.members := v_result;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.guard_trip_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
DECLARE
  v_internal_role_change BOOLEAN :=
    current_setting('stellar_star.role_change', true) = 'on';
  v_self_join BOOLEAN :=
    public.trip_member_role(OLD.id, public.current_wallet()) IS NULL
    AND public.current_wallet() IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) member
      WHERE upper(btrim(COALESCE(member ->> 'walletAddress', ''))) =
            upper(btrim(public.current_wallet()))
    )
    AND (to_jsonb(NEW) - 'members' - 'member_wallets' - 'updated_at')
          IS NOT DISTINCT FROM
        (to_jsonb(OLD) - 'members' - 'member_wallets' - 'updated_at');
BEGIN
  IF NEW.members IS DISTINCT FROM OLD.members AND NOT v_internal_role_change
     AND NOT v_self_join
     AND NOT public.trip_has_permission(OLD.id, 'members.manage') THEN
    RAISE EXCEPTION 'TRIP_MEMBERS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF NEW.expense_ids IS DISTINCT FROM OLD.expense_ids
     AND NOT v_internal_role_change
     AND NOT public.trip_has_permission(OLD.id, 'expenses.manage') THEN
    RAISE EXCEPTION 'EXPENSE_LINK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  IF (to_jsonb(NEW) - 'members' - 'member_wallets' - 'expense_ids' - 'updated_at')
       IS DISTINCT FROM
     (to_jsonb(OLD) - 'members' - 'member_wallets' - 'expense_ids' - 'updated_at')
     AND NOT v_internal_role_change
     AND NOT public.trip_has_permission(OLD.id, 'trip.settings.manage') THEN
    RAISE EXCEPTION 'TRIP_SETTINGS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_014_trips_guard_authorization ON public.trips;
CREATE TRIGGER trg_014_trips_guard_authorization
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_update();

DROP TRIGGER IF EXISTS trg_015_trips_normalize_roles ON public.trips;
CREATE TRIGGER trg_015_trips_normalize_roles
  BEFORE INSERT OR UPDATE OF members ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.normalize_trip_member_roles();

CREATE OR REPLACE FUNCTION public.update_expense_versioned(
  p_id UUID,
  p_expected_version INT,
  p_title TEXT,
  p_description TEXT,
  p_total_amount TEXT,
  p_currency TEXT,
  p_split_mode TEXT,
  p_paid_by_member_id TEXT,
  p_members JSONB,
  p_shares JSONB,
  p_settled BOOLEAN
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_current_version INT;
BEGIN
  IF NOT public.expense_has_permission(p_id, 'expenses.manage') THEN
    RAISE EXCEPTION 'EXPENSE_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;

  SELECT version INTO v_current_version
  FROM public.expenses
  WHERE id = p_id
  FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Version conflict: expected %, got %', p_expected_version, v_current_version
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY UPDATE public.expenses
  SET title = COALESCE(p_title, title),
      description = COALESCE(p_description, description),
      split_mode = COALESCE(p_split_mode, split_mode),
      paid_by_member_id = COALESCE(p_paid_by_member_id, paid_by_member_id),
      members = COALESCE(p_members, members),
      shares = COALESCE(p_shares, shares),
      settled = COALESCE(p_settled, settled),
      version = version + 1
  WHERE id = p_id
  RETURNING *;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.set_trip_member_role(
  p_trip_id UUID,
  p_member_id TEXT,
  p_role TEXT,
  p_custom_permissions TEXT[] DEFAULT ARRAY[]::TEXT[]
)
RETURNS public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trip public.trips;
  v_target JSONB;
  v_previous_role TEXT;
  v_previous_permissions TEXT[];
  v_owner_count INT;
  v_members JSONB;
  v_next_permissions TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF p_role NOT IN ('owner', 'organizer', 'contributor', 'viewer', 'custom') THEN
    RAISE EXCEPTION 'INVALID_ROLE';
  END IF;
  IF p_role = 'custom' AND EXISTS (
    SELECT 1 FROM unnest(COALESCE(p_custom_permissions, ARRAY[]::TEXT[])) permission
    WHERE permission IS NULL OR permission NOT IN (
      'trip.settings.manage', 'members.manage', 'expenses.manage',
      'receipts.manage', 'exports.view', 'reminders.manage',
      'settlement.proposals.manage'
    )
  ) THEN
    RAISE EXCEPTION 'INVALID_CUSTOM_PERMISSION';
  END IF;

  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIP_NOT_FOUND'; END IF;
  IF public.trip_member_role(p_trip_id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'ROLE_CHANGE_FORBIDDEN';
  END IF;
  SELECT member INTO v_target
  FROM jsonb_array_elements(v_trip.members) member
  WHERE member ->> 'id' = p_member_id
  LIMIT 1;
  IF v_target IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
  IF p_role = 'owner' AND btrim(COALESCE(v_target ->> 'walletAddress', '')) = '' THEN
    RAISE EXCEPTION 'OWNER_REQUIRES_WALLET';
  END IF;

  v_previous_role := COALESCE(
    v_target ->> 'role',
    CASE
      WHEN upper(btrim(COALESCE(v_target ->> 'walletAddress', ''))) = upper(btrim(v_trip.created_by_wallet))
      THEN 'owner'
      ELSE 'contributor'
    END
  );
  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
  INTO v_previous_permissions
  FROM jsonb_array_elements_text(COALESCE(v_target -> 'customPermissions', '[]'::jsonb)) value;
  IF p_role = 'custom' THEN v_next_permissions := COALESCE(p_custom_permissions, ARRAY[]::TEXT[]); END IF;

  SELECT count(*) INTO v_owner_count
  FROM jsonb_array_elements(v_trip.members) member
  WHERE COALESCE(
    member ->> 'role',
    CASE
      WHEN upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(v_trip.created_by_wallet))
      THEN 'owner'
      ELSE 'contributor'
    END
  ) = 'owner'
    AND btrim(COALESCE(member ->> 'walletAddress', '')) <> '';
  IF v_previous_role = 'owner' AND p_role <> 'owner' AND v_owner_count = 1 THEN
    RAISE EXCEPTION 'OWNERSHIP_TRANSFER_REQUIRED';
  END IF;
  IF v_previous_role = p_role AND v_previous_permissions = v_next_permissions THEN
    RETURN v_trip;
  END IF;

  SELECT jsonb_agg(
    CASE WHEN member ->> 'id' = p_member_id THEN
      (member - 'customPermissions') || jsonb_build_object('role', p_role) ||
      CASE WHEN p_role = 'custom'
        THEN jsonb_build_object('customPermissions', to_jsonb(v_next_permissions))
        ELSE '{}'::jsonb
      END
    ELSE member END
  ) INTO v_members
  FROM jsonb_array_elements(v_trip.members) member;

  PERFORM set_config('stellar_star.role_change', 'on', true);
  UPDATE public.trips SET members = v_members WHERE id = p_trip_id RETURNING * INTO v_trip;

  INSERT INTO public.trip_role_audit (
    trip_id, member_id, previous_role, next_role,
    previous_custom_permissions, next_custom_permissions, changed_by_wallet
  ) VALUES (
    p_trip_id, p_member_id, v_previous_role, p_role,
    v_previous_permissions, v_next_permissions, public.current_wallet()
  );
  RETURN v_trip;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.transfer_trip_ownership(p_trip_id UUID, p_new_owner_member_id TEXT)
RETURNS public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trip public.trips;
  v_actor_member JSONB;
  v_target_member JSONB;
  v_actor_id TEXT;
  v_actor_previous_role TEXT;
  v_target_previous_role TEXT;
  v_actor_previous_permissions TEXT[];
  v_target_previous_permissions TEXT[];
  v_members JSONB;
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIP_NOT_FOUND'; END IF;
  IF public.trip_member_role(p_trip_id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'OWNERSHIP_TRANSFER_FORBIDDEN';
  END IF;

  SELECT member INTO v_actor_member
  FROM jsonb_array_elements(v_trip.members) member
  WHERE upper(btrim(COALESCE(member ->> 'walletAddress', ''))) =
        upper(btrim(public.current_wallet()))
    AND COALESCE(member ->> 'role', 'owner') = 'owner'
  LIMIT 1;
  SELECT member INTO v_target_member
  FROM jsonb_array_elements(v_trip.members) member
  WHERE member ->> 'id' = p_new_owner_member_id
  LIMIT 1;
  IF v_actor_member IS NULL OR v_target_member IS NULL
     OR btrim(COALESCE(v_target_member ->> 'walletAddress', '')) = '' THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND';
  END IF;
  v_actor_id := v_actor_member ->> 'id';
  IF v_actor_id = p_new_owner_member_id THEN RAISE EXCEPTION 'ALREADY_OWNER'; END IF;

  v_actor_previous_role := COALESCE(v_actor_member ->> 'role', 'owner');
  v_target_previous_role := COALESCE(
    v_target_member ->> 'role',
    CASE
      WHEN upper(btrim(COALESCE(v_target_member ->> 'walletAddress', ''))) = upper(btrim(v_trip.created_by_wallet))
      THEN 'owner'
      ELSE 'contributor'
    END
  );
  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_actor_previous_permissions
  FROM jsonb_array_elements_text(COALESCE(v_actor_member -> 'customPermissions', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_target_previous_permissions
  FROM jsonb_array_elements_text(COALESCE(v_target_member -> 'customPermissions', '[]'::jsonb)) value;

  SELECT jsonb_agg(CASE
    WHEN member ->> 'id' = v_actor_id THEN (member - 'customPermissions') || jsonb_build_object('role', 'organizer')
    WHEN member ->> 'id' = p_new_owner_member_id THEN (member - 'customPermissions') || jsonb_build_object('role', 'owner')
    ELSE member
  END) INTO v_members
  FROM jsonb_array_elements(v_trip.members) member;

  PERFORM set_config('stellar_star.role_change', 'on', true);
  UPDATE public.trips SET members = v_members WHERE id = p_trip_id RETURNING * INTO v_trip;

  INSERT INTO public.trip_role_audit (
    trip_id, member_id, previous_role, next_role,
    previous_custom_permissions, next_custom_permissions, changed_by_wallet
  ) VALUES
    (p_trip_id, v_actor_id, v_actor_previous_role, 'organizer',
     v_actor_previous_permissions, ARRAY[]::TEXT[], public.current_wallet()),
    (p_trip_id, p_new_owner_member_id, v_target_previous_role, 'owner',
     v_target_previous_permissions, ARRAY[]::TEXT[], public.current_wallet());
  RETURN v_trip;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.add_expense_to_trip(p_trip_id UUID, p_expense_id UUID)
RETURNS TEXT[]
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_ids TEXT[];
BEGIN
  IF NOT public.trip_has_permission(p_trip_id, 'expenses.manage') THEN
    RAISE EXCEPTION 'EXPENSE_LINK_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.expenses WHERE id = p_expense_id) THEN
    RAISE EXCEPTION 'EXPENSE_NOT_FOUND';
  END IF;
  UPDATE public.trips
  SET expense_ids = ARRAY(SELECT DISTINCT unnest(expense_ids || ARRAY[p_expense_id::TEXT]))
  WHERE id = p_trip_id
  RETURNING expense_ids INTO v_ids;
  RETURN v_ids;
END;
$fn$;

ALTER TABLE public.trip_role_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_role_audit_select_members ON public.trip_role_audit;
CREATE POLICY trip_role_audit_select_members ON public.trip_role_audit
  FOR SELECT TO authenticated
  USING (public.trip_member_role(trip_id, public.current_wallet()) IS NOT NULL);

DROP POLICY IF EXISTS trips_update_member ON public.trips;
DROP POLICY IF EXISTS trips_update_members ON public.trips;
DROP POLICY IF EXISTS trips_update_authorized ON public.trips;
CREATE POLICY trips_update_authorized ON public.trips
  FOR UPDATE TO authenticated
  USING (
    public.trip_has_permission(id, 'trip.settings.manage')
    OR public.trip_has_permission(id, 'members.manage')
    OR public.trip_has_permission(id, 'expenses.manage')
  )
  WITH CHECK (
    public.trip_has_permission(id, 'trip.settings.manage')
    OR public.trip_has_permission(id, 'members.manage')
    OR public.trip_has_permission(id, 'expenses.manage')
  );

DROP POLICY IF EXISTS expenses_update_member ON public.expenses;
DROP POLICY IF EXISTS expenses_update_members ON public.expenses;
DROP POLICY IF EXISTS expenses_update_authorized ON public.expenses;
CREATE POLICY expenses_update_authorized ON public.expenses
  FOR UPDATE TO authenticated
  USING (public.expense_has_permission(id, 'expenses.manage'))
  WITH CHECK (public.expense_has_permission(id, 'expenses.manage'));

DROP POLICY IF EXISTS expenses_delete_owner ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_creator ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_authorized ON public.expenses;
CREATE POLICY expenses_delete_authorized ON public.expenses
  FOR DELETE TO authenticated
  USING (public.expense_has_permission(id, 'expenses.manage'));

DROP POLICY IF EXISTS trip_invites_insert_members ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_insert_authorized ON public.trip_invites;
CREATE POLICY trip_invites_insert_authorized ON public.trip_invites
  FOR INSERT TO authenticated
  WITH CHECK (
    created_by_wallet = public.current_wallet()
    AND public.trip_has_permission(trip_id, 'members.manage')
  );

DROP POLICY IF EXISTS trip_invites_update_creator ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_update_authorized ON public.trip_invites;
CREATE POLICY trip_invites_update_authorized ON public.trip_invites
  FOR UPDATE TO authenticated
  USING (public.trip_has_permission(trip_id, 'members.manage'))
  WITH CHECK (public.trip_has_permission(trip_id, 'members.manage'));

DROP POLICY IF EXISTS expense_receipts_select_members ON public.expense_receipts;
CREATE POLICY expense_receipts_select_members ON public.expense_receipts
  FOR SELECT TO authenticated
  USING (public.expense_has_permission(expense_id, 'receipts.manage'));

DROP POLICY IF EXISTS payment_reminders_insert_sender ON public.payment_reminders;
CREATE POLICY payment_reminders_insert_sender ON public.payment_reminders
  FOR INSERT TO authenticated
  WITH CHECK (
    sender_wallet = public.current_wallet()
    AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
  );

DROP POLICY IF EXISTS payment_reminders_update_party ON public.payment_reminders;
CREATE POLICY payment_reminders_update_party ON public.payment_reminders
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() = recipient_wallet
    OR (
      public.current_wallet() = sender_wallet
      AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
    )
  )
  WITH CHECK (
    public.current_wallet() = recipient_wallet
    OR (
      public.current_wallet() = sender_wallet
      AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
    )
  );

DROP POLICY IF EXISTS reminder_events_insert_actor ON public.reminder_events;
CREATE POLICY reminder_events_insert_actor ON public.reminder_events
  FOR INSERT TO authenticated
  WITH CHECK (
    actor_wallet = public.current_wallet()
    AND (
      (
        reminder_id IS NULL
        AND kind IN (
          'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender',
          'opted_in', 'opted_out', 'unsubscribed', 'schedule_created', 'schedule_disabled'
        )
      )
      OR EXISTS (
        SELECT 1 FROM public.payment_reminders r
        WHERE r.id = reminder_id
          AND (
            (
              r.sender_wallet = public.current_wallet()
              AND public.trip_has_permission(r.trip_id::UUID, 'reminders.manage')
            )
            OR (
              r.recipient_wallet = public.current_wallet()
              AND kind IN ('read', 'dismissed', 'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender')
            )
          )
      )
    )
  );

DROP POLICY IF EXISTS reminder_schedules_owner ON public.reminder_schedules;
CREATE POLICY reminder_schedules_owner ON public.reminder_schedules
  FOR ALL TO authenticated
  USING (
    owner_wallet = public.current_wallet()
    AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
  )
  WITH CHECK (
    owner_wallet = public.current_wallet()
    AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
  );

DROP POLICY IF EXISTS settlement_proposals_insert_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_insert_member ON public.settlement_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    creator_wallet = public.current_wallet()
    AND status = 'open'
    AND public.trip_has_permission(trip_id::UUID, 'settlement.proposals.manage')
  );

DROP POLICY IF EXISTS settlement_proposals_update_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_update_member ON public.settlement_proposals
  FOR UPDATE TO authenticated
  USING (public.trip_has_permission(trip_id::UUID, 'settlement.proposals.manage'))
  WITH CHECK (
    status <> 'revoked'
    OR creator_wallet = public.current_wallet()
  );

REVOKE ALL ON FUNCTION public.trip_member_role(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_has_permission(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_has_permission(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_trip_member_role(UUID, TEXT, TEXT, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_trip_ownership(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_expense_to_trip(UUID, UUID) FROM PUBLIC;
GRANT SELECT ON public.trip_role_audit TO authenticated;
GRANT EXECUTE ON FUNCTION public.trip_member_role(UUID, TEXT),
  public.trip_has_permission(UUID, TEXT),
  public.expense_has_permission(UUID, TEXT),
  public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN),
  public.set_trip_member_role(UUID, TEXT, TEXT, TEXT[]),
  public.transfer_trip_ownership(UUID, TEXT),
  public.add_expense_to_trip(UUID, UUID)
TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0016', '0016_trip_roles_and_permissions', 'trip_roles_permissions_v2')
ON CONFLICT (version) DO NOTHING;
