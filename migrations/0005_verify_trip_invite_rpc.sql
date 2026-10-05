-- ============================================================================
-- 0005 — Public invite verification RPC (ISSUE #221)
-- ============================================================================
-- Receiving an invite link is, by definition, something that happens before you
-- are a member of the trip — and usually before you have a wallet session at
-- all. But `trip_invites_select_members` and `trips_select_members` both gate
-- SELECT on `member_wallets @> ARRAY[public.current_wallet()]`, so the prospective
-- member fails both checks: unauthenticated, current_wallet() is NULL; and even
-- signed in, they are not yet in member_wallets. Both reads in verifyTripInvite()
-- returned zero rows, which that code reports as "Invalid or unrecognized
-- invitation link." Every invite link in the product was a dead end — a 404 that
-- looked like a bad token rather than a permissions problem.
--
-- Relaxing those policies is not an option: a policy broad enough to let a
-- stranger read an invite row is broad enough to let them enumerate invites, and
-- the trips policy guards the whole expense/member graph.
--
-- Instead this adds a single SECURITY DEFINER function that answers exactly one
-- question — "is this token hash valid, and what may its bearer see?" — and
-- returns only the fields /join renders. Holding the token IS the capability;
-- the function is the only way to spend it, and it cannot be used to read
-- anything else.
--
-- ROLLBACK: DROP FUNCTION public.verify_trip_invite(TEXT); invite links revert to
-- returning 404 as described above.

-- ─── VERIFY RPC ──────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.verify_trip_invite(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned so a SECURITY DEFINER body can never resolve a name through a caller
-- controlled schema. pg_temp last, and explicit, for the same reason.
SET search_path = public, pg_temp
STABLE
AS $fn$
DECLARE
  v_invite RECORD;
  v_trip RECORD;
  v_member_name TEXT;
  v_unclaimed JSONB;
BEGIN
  IF p_token_hash IS NULL OR btrim(p_token_hash) = '' THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invitation token is required';
  END IF;

  -- 1. Resolve the capability. token_hash is UNIQUE, and the caller only ever
  --    holds the pre-image, so this is the one lookup the token authorizes.
  SELECT id, trip_id, member_id, created_by_wallet, expires_at, max_uses, uses, revoked
    INTO v_invite
    FROM public.trip_invites
   WHERE token_hash = p_token_hash;

  -- Deliberately the same error for "no such token" as for a malformed one: a
  -- caller guessing hashes learns nothing from the difference.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invalid or unrecognized invitation link';
  END IF;

  -- 2. Validity. Reported as distinct errors on purpose — someone holding a
  --    real-but-expired link needs to be told to ask for a new one, not that
  --    their link was never real.
  IF v_invite.revoked THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invitation has been revoked';
  END IF;

  IF v_invite.expires_at <= NOW() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired';
  END IF;

  IF v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invitation has already reached its maximum uses';
  END IF;

  -- 3. Trip metadata. Only the columns /join actually renders; `members` is read
  --    but never returned whole — see below.
  SELECT id, name, description, members
    INTO v_trip
    FROM public.trips
   WHERE id = v_invite.trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND: The trip associated with this invite no longer exists';
  END IF;

  -- 4. Unclaimed slots, reduced to {id, name}. The raw members array carries the
  --    wallet address of every existing member; projecting here means an invite
  --    link can never be used to harvest the roster of a trip you have not
  --    joined. A slot counts as unclaimed only when it has no wallet attached.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m ->> 'id', 'name', m ->> 'name')), '[]'::jsonb)
    INTO v_unclaimed
    FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS m
   WHERE (m ->> 'walletAddress') IS NULL
      OR btrim(m ->> 'walletAddress') = '';

  -- 5. When the invite names a specific slot, surface that slot's display name
  --    so the page can say which identity is being claimed.
  IF v_invite.member_id IS NOT NULL THEN
    SELECT m ->> 'name'
      INTO v_member_name
      FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS m
     WHERE (m ->> 'id') = v_invite.member_id
     LIMIT 1;
  END IF;

  -- The validity flags are all false by construction: any true case raised
  -- above. They are returned anyway because TripInviteSummary declares them,
  -- and a client that reads them should not have to special-case their absence.
  RETURN jsonb_build_object(
    'invite_id', v_invite.id,
    'trip_id', v_trip.id,
    'trip_name', v_trip.name,
    'trip_description', v_trip.description,
    'member_id', v_invite.member_id,
    'member_name', v_member_name,
    'inviter_wallet', v_invite.created_by_wallet,
    'expires_at', v_invite.expires_at,
    'unclaimed_members', v_unclaimed,
    'is_expired', FALSE,
    'is_revoked', FALSE,
    'is_exhausted', FALSE
  );
END;
$fn$;

COMMENT ON FUNCTION public.verify_trip_invite(TEXT) IS
  'Validates an invite token hash and returns only the public metadata /join renders. '
  'SECURITY DEFINER because the prospective member is not yet a trip member and so '
  'cannot pass the RLS policies on trip_invites or trips. Possession of the token is '
  'the capability; no other row is reachable through this function.';

-- anon is the point: the recipient has no session when they open the link.
GRANT EXECUTE ON FUNCTION public.verify_trip_invite(TEXT) TO anon, authenticated;

-- ─── RECORD MIGRATION ────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0005', '0005_verify_trip_invite_rpc', 'verify_trip_invite_v1')
ON CONFLICT (version) DO NOTHING;
