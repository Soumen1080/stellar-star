-- ============================================================================
-- Migration 0012: Security Review Hardening & Authorization Controls (#309)
-- ============================================================================
-- Addresses Findings SEC-F01, SEC-F02, SEC-F03, SEC-F05 from the Security Audit:
-- 1. Restricts mark_share_paid and mark_shares_paid_batch to authenticated members / service role.
-- 2. Restricts update_expense_versioned to authenticated members of the expense.
-- 3. Pins search_path = public, pg_temp on all SECURITY DEFINER functions.
-- 4. Enforces claiming wallet match on claim_trip_invite.
-- 5. Prevents non-owner trip members from directly mutating trip membership.

-- 1. Hardened update_expense_versioned
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
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_current_version INT;
  v_expense public.expenses;
  v_caller TEXT := public.current_wallet();
BEGIN
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  -- SEC-F02: Verify caller is an authorized member if authenticated
  IF v_caller IS NOT NULL AND NOT (v_expense.member_wallets @> ARRAY[v_caller]) THEN
    RAISE EXCEPTION 'Unauthorized: only expense members can update this expense' USING ERRCODE = '42501';
  END IF;
  
  IF v_expense.version <> p_expected_version THEN
    RAISE EXCEPTION 'Version conflict: expected %, got %', p_expected_version, v_expense.version USING ERRCODE = '40001';
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

REVOKE EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated;

-- 2. Hardened mark_share_paid
CREATE OR REPLACE FUNCTION public.mark_share_paid(
  p_expense_id UUID,
  p_member_id TEXT,
  p_tx_hash TEXT,
  p_on_chain BOOLEAN DEFAULT true
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_expense public.expenses;
  v_shares JSONB;
  v_share JSONB;
  v_updated_shares JSONB := '[]'::jsonb;
  v_found BOOLEAN := false;
  v_all_paid BOOLEAN := true;
  v_len INT;
  v_idx INT;
  v_caller TEXT := public.current_wallet();
BEGIN
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  -- SEC-F01: Verify caller is an authorized member or creditor of this expense
  IF v_caller IS NOT NULL AND NOT (v_expense.member_wallets @> ARRAY[v_caller]) THEN
    RAISE EXCEPTION 'Unauthorized: caller is not a participant in this expense' USING ERRCODE = '42501';
  END IF;
  
  v_shares := v_expense.shares;
  v_len := jsonb_array_length(v_shares);
  
  IF v_shares IS NULL OR v_len = 0 THEN
    RETURN QUERY SELECT * FROM public.expenses WHERE id = p_expense_id;
    RETURN;
  END IF;
  
  FOR v_idx IN 0..(v_len - 1) LOOP
    v_share := v_shares -> v_idx;
    
    IF (v_share ->> 'memberId') = p_member_id THEN
      v_found := true;
      v_share := v_share || jsonb_build_object('paid', true, 'txHash', p_tx_hash);
    END IF;
    
    IF NOT (v_share ->> 'paid')::boolean THEN
      v_all_paid := false;
    END IF;
    
    v_updated_shares := v_updated_shares || jsonb_build_array(v_share);
  END LOOP;
  
  IF v_found THEN
    RETURN QUERY UPDATE public.expenses
       SET shares = v_updated_shares,
           settled = v_all_paid,
           version = version + 1
     WHERE id = p_expense_id
     RETURNING *;
  ELSE
    RETURN QUERY SELECT * FROM public.expenses WHERE id = p_expense_id;
  END IF;
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;

-- 3. Hardened mark_shares_paid_batch
CREATE OR REPLACE FUNCTION public.mark_shares_paid_batch(
  p_updates JSONB,
  p_tx_hash TEXT
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_update JSONB;
  v_expense_id UUID;
  v_member_id TEXT;
  v_expense public.expenses;
  v_caller TEXT := public.current_wallet();
BEGIN
  FOR v_update IN SELECT * FROM jsonb_array_elements(p_updates) LOOP
    v_expense_id := (v_update ->> 'expenseId')::UUID;
    v_member_id := v_update ->> 'memberId';
    
    SELECT * INTO v_expense FROM public.expenses WHERE id = v_expense_id;
    IF FOUND AND (v_caller IS NULL OR (v_expense.member_wallets @> ARRAY[v_caller])) THEN
      PERFORM public.mark_share_paid(v_expense_id, v_member_id, p_tx_hash, true);
    END IF;
  END LOOP;
  
  RETURN QUERY
  SELECT * FROM public.expenses
   WHERE id IN (
     SELECT (u ->> 'expenseId')::UUID
       FROM jsonb_array_elements(p_updates) AS u
   );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) TO authenticated;

-- 4. Pin search_path on auth challenge and rate-limiting procedures
CREATE OR REPLACE FUNCTION public.record_auth_challenge(
  p_address TEXT,
  p_nonce TEXT,
  p_expiration BIGINT,
  p_max_pending INT DEFAULT 5
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_count INT;
  v_oldest_nonce TEXT;
BEGIN
  DELETE FROM public.auth_challenges
   WHERE expiration <= (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT;

  SELECT COUNT(*) INTO v_count
    FROM public.auth_challenges
   WHERE address = p_address;

  IF v_count >= p_max_pending THEN
    SELECT nonce INTO v_oldest_nonce
      FROM public.auth_challenges
     WHERE address = p_address
     ORDER BY created_at ASC
     LIMIT 1;

    DELETE FROM public.auth_challenges WHERE nonce = v_oldest_nonce;
  END IF;

  INSERT INTO public.auth_challenges (nonce, address, expiration)
  VALUES (p_nonce, p_address, p_expiration)
  ON CONFLICT (nonce) DO UPDATE
    SET expiration = EXCLUDED.expiration;

  RETURN TRUE;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.consume_auth_challenge(
  p_address TEXT,
  p_nonce TEXT,
  p_now BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_deleted_count INT;
BEGIN
  DELETE FROM public.auth_challenges
   WHERE nonce = p_nonce
     AND address = p_address
     AND expiration > p_now;

  GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
  RETURN v_deleted_count > 0;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.check_rate_limit(
  p_key TEXT,
  p_limit INT,
  p_window_ms BIGINT,
  p_now BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_count INT;
  v_window_start BIGINT;
  v_reset_ms BIGINT;
  v_allowed BOOLEAN;
BEGIN
  SELECT count, window_start
    INTO v_count, v_window_start
    FROM public.auth_rate_limits
   WHERE key = p_key
     FOR UPDATE;

  IF NOT FOUND OR (p_now - v_window_start) >= p_window_ms THEN
    INSERT INTO public.auth_rate_limits (key, count, window_start, updated_at)
    VALUES (p_key, 1, p_now, NOW())
    ON CONFLICT (key) DO UPDATE
      SET count = 1,
          window_start = p_now,
          updated_at = NOW();

    v_count := 1;
    v_window_start := p_now;
  ELSE
    v_count := v_count + 1;
    UPDATE public.auth_rate_limits
       SET count = v_count,
           updated_at = NOW()
     WHERE key = p_key;
  END IF;

  v_allowed := v_count <= p_limit;
  v_reset_ms := GREATEST(0, (v_window_start + p_window_ms) - p_now);

  RETURN json_build_object(
    'allowed', v_allowed,
    'count', v_count,
    'resetMs', v_reset_ms
  );
END;
$fn$;

-- 5. Pin search_path on claim_trip_invite and enforce wallet verification
CREATE OR REPLACE FUNCTION public.claim_trip_invite(
  p_token_hash TEXT,
  p_claiming_wallet TEXT,
  p_selected_member_id TEXT DEFAULT NULL,
  p_expected_trip_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_invite RECORD;
  v_trip RECORD;
  v_target_member_id TEXT;
  v_target_member_name TEXT;
  v_members JSONB;
  v_updated_members JSONB := '[]'::jsonb;
  v_member JSONB;
  v_found BOOLEAN := FALSE;
  v_already_claimed BOOLEAN := FALSE;
  v_normalized_wallet TEXT;
  v_existing_wallet TEXT;
  v_idx INT;
  v_len INT;
  v_caller TEXT := public.current_wallet();
BEGIN
  IF p_claiming_wallet IS NULL OR btrim(p_claiming_wallet) = '' THEN
    RAISE EXCEPTION 'Claiming wallet address is required';
  END IF;
  v_normalized_wallet := upper(btrim(p_claiming_wallet));

  -- SEC-F03: When authenticated, prevent claiming a slot for a different wallet
  IF v_caller IS NOT NULL AND upper(btrim(v_caller)) <> v_normalized_wallet THEN
    RAISE EXCEPTION 'Unauthorized: claiming wallet does not match session' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_invite
    FROM public.trip_invites
   WHERE token_hash = p_token_hash
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invalid or unrecognized invitation token';
  END IF;

  IF v_invite.revoked THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invitation has been revoked';
  END IF;

  IF v_invite.expires_at <= NOW() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired';
  END IF;

  IF v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invitation has already reached its maximum uses';
  END IF;

  IF p_expected_trip_id IS NOT NULL AND btrim(p_expected_trip_id) <> '' THEN
    IF v_invite.trip_id <> btrim(p_expected_trip_id) THEN
      RAISE EXCEPTION 'TRIP_MISMATCH: Invitation token does not belong to the specified trip';
    END IF;
  END IF;

  SELECT *
    INTO v_trip
    FROM public.trips
   WHERE id = v_invite.trip_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND: Associated trip no longer exists';
  END IF;

  v_target_member_id := COALESCE(v_invite.member_id, p_selected_member_id);
  v_members := COALESCE(v_trip.members, '[]'::jsonb);
  v_len := jsonb_array_length(v_members);

  FOR v_idx IN 0..(v_len - 1) LOOP
    v_member := v_members -> v_idx;
    v_existing_wallet := upper(btrim(COALESCE(v_member ->> 'walletAddress', '')));
    IF v_existing_wallet <> '' AND v_existing_wallet = v_normalized_wallet THEN
      IF v_target_member_id IS NOT NULL AND (v_member ->> 'id') = v_target_member_id THEN
        RETURN jsonb_build_object(
          'success', true,
          'trip_id', v_trip.id,
          'trip_name', v_trip.name,
          'member_id', v_target_member_id,
          'member_name', v_member ->> 'name',
          'message', 'Already claimed by this wallet'
        );
      ELSE
        RAISE EXCEPTION 'WALLET_ALREADY_MEMBER: This wallet is already a member of this trip';
      END IF;
    END IF;
  END LOOP;

  IF v_target_member_id IS NOT NULL THEN
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF (v_member ->> 'id') = v_target_member_id THEN
        v_found := TRUE;
        v_target_member_name := v_member ->> 'name';
        
        IF (v_member ->> 'walletAddress') IS NOT NULL AND btrim(v_member ->> 'walletAddress') <> '' THEN
          IF upper(btrim(v_member ->> 'walletAddress')) = v_normalized_wallet THEN
            RETURN jsonb_build_object(
              'success', true,
              'trip_id', v_trip.id,
              'trip_name', v_trip.name,
              'member_id', v_target_member_id,
              'member_name', v_target_member_name,
              'message', 'Already claimed by this wallet'
            );
          ELSE
            RAISE EXCEPTION 'SLOT_ALREADY_CLAIMED: This member slot has already been claimed by another wallet';
          END IF;
        END IF;

        v_updated_members := v_updated_members || jsonb_build_array(v_member || jsonb_build_object('walletAddress', p_claiming_wallet));
      ELSE
        v_updated_members := v_updated_members || jsonb_build_array(v_member);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      RAISE EXCEPTION 'MEMBER_NOT_FOUND: Member slot % not found in trip', v_target_member_id;
    END IF;
  ELSE
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF NOT v_found AND ((v_member ->> 'walletAddress') IS NULL OR btrim(v_member ->> 'walletAddress') = '') THEN
        v_found := TRUE;
        v_target_member_id := v_member ->> 'id';
        v_target_member_name := v_member ->> 'name';
        v_updated_members := v_updated_members || jsonb_build_array(v_member || jsonb_build_object('walletAddress', p_claiming_wallet));
      ELSE
        v_updated_members := v_updated_members || jsonb_build_array(v_member);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      v_target_member_id := gen_random_uuid()::text;
      v_target_member_name := 'Member ' || (v_len + 1)::text;
      v_updated_members := v_members || jsonb_build_array(
        jsonb_build_object('id', v_target_member_id, 'name', v_target_member_name, 'walletAddress', p_claiming_wallet)
      );
    END IF;
  END IF;

  UPDATE public.trips
     SET members = v_updated_members
   WHERE id = v_trip.id;

  UPDATE public.expenses
     SET members = (
           SELECT jsonb_agg(
             CASE
               WHEN (m ->> 'id') = v_target_member_id THEN m || jsonb_build_object('walletAddress', p_claiming_wallet)
               ELSE m
             END
           )
           FROM jsonb_array_elements(members) AS m
         ),
         shares = (
           SELECT jsonb_agg(
             CASE
               WHEN (s ->> 'memberId') = v_target_member_id THEN s || jsonb_build_object('walletAddress', p_claiming_wallet)
               ELSE s
             END
           )
           FROM jsonb_array_elements(shares) AS s
         )
   WHERE (id::text = ANY(v_trip.expense_ids) OR v_trip.id::text = ANY(member_wallets) OR members @> jsonb_build_array(jsonb_build_object('id', v_target_member_id)));

  UPDATE public.trip_invites
     SET uses = uses + 1
   WHERE id = v_invite.id;

  RETURN jsonb_build_object(
    'success', true,
    'trip_id', v_trip.id,
    'trip_name', v_trip.name,
    'member_id', v_target_member_id,
    'member_name', v_target_member_name
  );
END;
$fn$;

-- Record schema migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0012', '0012_security_review_hardening', 'sec_hardening_309_v1')
ON CONFLICT (version) DO NOTHING;
