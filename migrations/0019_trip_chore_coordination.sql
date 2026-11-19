-- ============================================================================
-- Migration 0019: Atomic chore completion and owner-only chore configuration
-- ============================================================================

CREATE OR REPLACE FUNCTION public.guard_trip_chore_configuration()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $fn$
BEGIN
  IF current_setting('stellar_star.role_change', true) = 'on' THEN
    RETURN NEW;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(OLD.workspace -> 'chores', '[]'::jsonb)) AS old_chore
    JOIN jsonb_array_elements(COALESCE(NEW.workspace -> 'chores', '[]'::jsonb)) AS new_chore
      ON old_chore ->> 'id' = new_chore ->> 'id'
    WHERE COALESCE(old_chore -> 'completionHistory', '[]'::jsonb)
          IS DISTINCT FROM COALESCE(new_chore -> 'completionHistory', '[]'::jsonb)
  ) OR EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(NEW.workspace -> 'chores', '[]'::jsonb)) AS new_chore
    WHERE COALESCE(new_chore -> 'completionHistory', '[]'::jsonb) <> '[]'::jsonb
      AND NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(OLD.workspace -> 'chores', '[]'::jsonb)) AS old_chore
        WHERE old_chore ->> 'id' = new_chore ->> 'id'
      )
  ) THEN
    RAISE EXCEPTION 'CHORE_HISTORY_SERVER_ONLY' USING ERRCODE = '42501';
  END IF;

  IF (NEW.workspace -> 'chores') IS DISTINCT FROM (OLD.workspace -> 'chores')
     OR (NEW.workspace -> 'choresEnabled') IS DISTINCT FROM (OLD.workspace -> 'choresEnabled') THEN
    IF public.trip_member_role(OLD.id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN
      RAISE EXCEPTION 'CHORE_CONFIGURATION_FORBIDDEN' USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_trips_guard_chore_configuration ON public.trips;
CREATE TRIGGER trg_trips_guard_chore_configuration
  BEFORE UPDATE OF workspace ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_chore_configuration();

CREATE OR REPLACE FUNCTION public.append_trip_chore_completion(
  p_trip_id UUID,
  p_chore_id TEXT
)
RETURNS SETOF public.trips
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_trip public.trips%ROWTYPE;
  v_workspace JSONB;
  v_chores JSONB;
  v_chore JSONB;
  v_history JSONB;
  v_completion JSONB;
  v_eligible_member_ids TEXT[];
  v_member_id TEXT;
  v_last_assignee TEXT;
  v_assigned_member_id TEXT;
  v_period_key TEXT;
  v_cadence TEXT;
  v_completion_index INTEGER;
  v_now TIMESTAMPTZ := NOW();
  v_today DATE := (NOW() AT TIME ZONE 'UTC')::DATE;
  v_previous_role_change TEXT := current_setting('stellar_star.role_change', true);
BEGIN
  IF public.current_wallet() IS NULL THEN
    RAISE EXCEPTION 'CHORE_COMPLETION_AUTHENTICATION_REQUIRED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_trip
  FROM public.trips
  WHERE id = p_trip_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND';
  END IF;

  SELECT member ->> 'id' INTO v_member_id
  FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS member
  WHERE upper(btrim(COALESCE(member ->> 'walletAddress', ''))) =
        upper(btrim(public.current_wallet()))
  LIMIT 1;

  IF v_member_id IS NULL THEN
    RAISE EXCEPTION 'TRIP_MEMBER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_workspace := COALESCE(v_trip.workspace, '{}'::jsonb);
  IF v_workspace ->> 'choresEnabled' = 'false' THEN
    RAISE EXCEPTION 'CHORE_COORDINATION_DISABLED';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements_text(
      COALESCE(v_workspace -> 'choreOptOutWallets', '[]'::jsonb)
    ) AS opted_out(wallet)
    WHERE upper(btrim(opted_out.wallet)) = upper(btrim(public.current_wallet()))
  ) THEN
    RAISE EXCEPTION 'CHORE_MEMBER_OPTED_OUT' USING ERRCODE = '42501';
  END IF;

  SELECT chore INTO v_chore
  FROM jsonb_array_elements(COALESCE(v_workspace -> 'chores', '[]'::jsonb)) AS chore
  WHERE chore ->> 'id' = p_chore_id
  LIMIT 1;

  IF v_chore IS NULL THEN
    RAISE EXCEPTION 'CHORE_NOT_FOUND';
  END IF;

  v_cadence := v_chore ->> 'cadence';
  IF v_cadence = 'daily' THEN
    v_period_key := to_char(v_today, 'YYYY-MM-DD');
  ELSIF v_cadence = 'weekly' THEN
    v_period_key := to_char(date_trunc('week', v_today::TIMESTAMP)::DATE, 'YYYY-MM-DD');
  ELSIF v_cadence = 'monthly' THEN
    v_period_key := to_char(v_today, 'YYYY-MM');
  ELSE
    RAISE EXCEPTION 'INVALID_CHORE_CADENCE';
  END IF;

  v_history := COALESCE(v_chore -> 'completionHistory', '[]'::jsonb);
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_history) AS completion
    WHERE completion ->> 'periodKey' = v_period_key
  ) THEN
    RAISE EXCEPTION 'CHORE_ALREADY_COMPLETED_THIS_PERIOD';
  END IF;

  SELECT array_agg(rotation.member_id ORDER BY rotation.ordinality)
  INTO v_eligible_member_ids
  FROM jsonb_array_elements_text(
    COALESCE(v_chore -> 'rotationMemberIds', '[]'::jsonb)
  ) WITH ORDINALITY AS rotation(member_id, ordinality)
  WHERE NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS member
    WHERE member ->> 'id' = rotation.member_id
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements_text(
          COALESCE(v_workspace -> 'choreOptOutWallets', '[]'::jsonb)
        ) AS opted_out(wallet)
        WHERE upper(btrim(opted_out.wallet)) =
              upper(btrim(COALESCE(member ->> 'walletAddress', '')))
      )
  );

  IF COALESCE(cardinality(v_eligible_member_ids), 0) = 0 THEN
    RAISE EXCEPTION 'CHORE_NO_ELIGIBLE_ASSIGNEE';
  END IF;

  v_last_assignee := v_history -> (jsonb_array_length(v_history) - 1) ->> 'assignedMemberId';
  v_completion_index := array_position(v_eligible_member_ids, v_last_assignee);
  IF v_completion_index IS NULL THEN
    v_completion_index := 1;
  ELSE
    v_completion_index := (v_completion_index % cardinality(v_eligible_member_ids)) + 1;
  END IF;
  v_assigned_member_id := v_eligible_member_ids[v_completion_index];

  IF v_member_id IS DISTINCT FROM v_assigned_member_id THEN
    RAISE EXCEPTION 'CHORE_ASSIGNED_MEMBER_REQUIRED' USING ERRCODE = '42501';
  END IF;

  v_completion := jsonb_build_object(
    'completedAt', v_now,
    'completedByWallet', public.current_wallet(),
    'assignedMemberId', v_assigned_member_id,
    'periodKey', v_period_key
  );
  v_chore := jsonb_set(
    v_chore,
    '{completionHistory}',
    v_history || jsonb_build_array(v_completion),
    true
  );

  SELECT jsonb_agg(
    CASE WHEN chore ->> 'id' = p_chore_id THEN v_chore ELSE chore END
    ORDER BY ordinal
  )
  INTO v_chores
  FROM jsonb_array_elements(COALESCE(v_workspace -> 'chores', '[]'::jsonb))
    WITH ORDINALITY AS item(chore, ordinal);

  v_workspace := jsonb_set(v_workspace, '{chores}', COALESCE(v_chores, '[]'::jsonb), true);

  PERFORM set_config('stellar_star.role_change', 'on', true);
  UPDATE public.trips
  SET workspace = v_workspace
  WHERE id = p_trip_id;
  PERFORM set_config('stellar_star.role_change', COALESCE(v_previous_role_change, ''), true);

  RETURN QUERY SELECT * FROM public.trips WHERE id = p_trip_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.guard_trip_chore_configuration() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_trip_chore_completion(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.append_trip_chore_completion(UUID, TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_trip_chore_coordination', 'trip_chore_coordination_v1')
ON CONFLICT (version) DO NOTHING;
