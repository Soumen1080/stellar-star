-- ============================================================================
-- Stellar-star Migration 0003: Reconcile drifted schema into migrations
-- ============================================================================
-- WHY THIS EXISTS
--
-- Objects were added directly to supabase-setup.sql (commits 0823a9e, dad56b6)
-- without a corresponding migration. That is the exact failure this migration
-- system exists to prevent: a database provisioned by running migrations was
-- missing auth challenge storage, auth rate limiting, trip invites, and the
-- optimistic-concurrency RPCs that application code calls at runtime — while a
-- database provisioned by pasting supabase-setup.sql had them.
--
-- This migration carries those objects into the versioned track so both paths
-- converge on one schema.
--
-- SAFETY
--
-- Every statement is idempotent (IF NOT EXISTS / CREATE OR REPLACE / DROP
-- POLICY IF EXISTS before CREATE POLICY). On a database already provisioned
-- from supabase-setup.sql this is a no-op that only records the version row;
-- on one built from migrations 0001-0002 it adds the missing objects. Neither
-- path loses data: there are no DROP TABLE, DROP COLUMN, or destructive ALTER
-- statements here.
--
-- ROLLBACK: see docs/DATABASE_MIGRATIONS.md. The down path is documented rather
-- than automated, because dropping these functions breaks authentication for
-- any running deployment; the safe reversal is to redeploy the previous
-- application version, which does not call them.


-- ─── AUTH CHALLENGES & RATE LIMITING (tables + indexes) ────────────────────────

CREATE TABLE IF NOT EXISTS public.auth_challenges (
  nonce          TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  expiration     BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_challenges_address_idx ON public.auth_challenges (address);

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  key            TEXT PRIMARY KEY,
  count          INT NOT NULL DEFAULT 1,
  window_start   BIGINT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── AUTH CHALLENGE / RATE-LIMIT RPCs ──────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.record_auth_challenge(
  p_address TEXT,
  p_nonce TEXT,
  p_expiration BIGINT,
  p_max_pending INT DEFAULT 5
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_count INT;
  v_oldest_nonce TEXT;
BEGIN
  -- 1. Delete expired challenges globally for this address
  DELETE FROM public.auth_challenges
   WHERE address = p_address AND expiration <= (extract(epoch from now()) * 1000)::bigint;

  -- 2. Enforce max pending per address
  SELECT count(*) INTO v_count FROM public.auth_challenges WHERE address = p_address;
  
  WHILE v_count >= p_max_pending LOOP
    SELECT nonce INTO v_oldest_nonce 
      FROM public.auth_challenges 
     WHERE address = p_address 
     ORDER BY created_at ASC 
     LIMIT 1;
     
    IF v_oldest_nonce IS NOT NULL THEN
      DELETE FROM public.auth_challenges WHERE nonce = v_oldest_nonce;
      v_count := v_count - 1;
    ELSE
      EXIT;
    END IF;
  END LOOP;

  -- 3. Insert new challenge
  INSERT INTO public.auth_challenges (nonce, address, expiration)
  VALUES (p_nonce, p_address, p_expiration);
  
  RETURN TRUE;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.consume_auth_challenge(
  p_address TEXT,
  p_nonce TEXT,
  p_expiration BIGINT,
  p_now BIGINT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_deleted_nonce TEXT;
BEGIN
  IF p_now > p_expiration THEN
    RETURN FALSE;
  END IF;

  DELETE FROM public.auth_challenges
   WHERE nonce = p_nonce
     AND address = p_address
     AND expiration = p_expiration
     AND expiration > p_now
  RETURNING nonce INTO v_deleted_nonce;

  RETURN v_deleted_nonce IS NOT NULL;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.check_auth_rate_limit(
  p_key TEXT,
  p_limit INT,
  p_window_ms BIGINT,
  p_now BIGINT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_row public.auth_rate_limits;
  v_allowed BOOLEAN;
  v_remaining INT;
  v_reset_ms BIGINT;
BEGIN
  -- Attempt to select for update
  SELECT * INTO v_row FROM public.auth_rate_limits WHERE key = p_key FOR UPDATE;

  IF NOT FOUND OR (p_now - v_row.window_start) >= p_window_ms THEN
    -- Upsert new window
    INSERT INTO public.auth_rate_limits (key, count, window_start, updated_at)
    VALUES (p_key, 1, p_now, NOW())
    ON CONFLICT (key) DO UPDATE 
       SET count = 1, window_start = p_now, updated_at = NOW();
       
    v_allowed := true;
    v_remaining := GREATEST(0, p_limit - 1);
    v_reset_ms := p_window_ms;
  ELSE
    IF v_row.count < p_limit THEN
      UPDATE public.auth_rate_limits
         SET count = v_row.count + 1, updated_at = NOW()
       WHERE key = p_key;
       
      v_allowed := true;
      v_remaining := GREATEST(0, p_limit - (v_row.count + 1));
      v_reset_ms := GREATEST(0::bigint, p_window_ms - (p_now - v_row.window_start));
    ELSE
      v_allowed := false;
      v_remaining := 0;
      v_reset_ms := GREATEST(0::bigint, p_window_ms - (p_now - v_row.window_start));
    END IF;
  END IF;

  RETURN json_build_object(
    'allowed', v_allowed,
    'remaining', v_remaining,
    'reset_ms', v_reset_ms
  );
END;
$fn$;

-- ─── TRIP INVITES (table, indexes, RLS, trigger) ───────────────────────────────

CREATE TABLE IF NOT EXISTS public.trip_invites (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  token_hash        TEXT NOT NULL UNIQUE,
  member_id         TEXT,
  created_by_wallet TEXT NOT NULL,
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days'),
  max_uses          INT NOT NULL DEFAULT 1 CHECK (max_uses > 0),
  uses              INT NOT NULL DEFAULT 0 CHECK (uses >= 0),
  revoked           BOOLEAN NOT NULL DEFAULT FALSE,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_invites_token_hash ON public.trip_invites (token_hash);
CREATE INDEX IF NOT EXISTS idx_trip_invites_trip_id    ON public.trip_invites (trip_id);
CREATE INDEX IF NOT EXISTS idx_trip_invites_creator    ON public.trip_invites (created_by_wallet);

ALTER TABLE public.trip_invites ENABLE ROW LEVEL SECURITY;

DO $drop_invite_policies$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT policyname, tablename
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename = 'trip_invites'
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$drop_invite_policies$;

-- Trip members can view invites for their trip.
DROP POLICY IF EXISTS "trip_invites_select_members" ON public.trip_invites;
CREATE POLICY "trip_invites_select_members" ON public.trip_invites
  FOR SELECT USING (
    trip_id IN (
      SELECT id FROM public.trips
       WHERE member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- Trip members can create invites for their trip.
DROP POLICY IF EXISTS "trip_invites_insert_members" ON public.trip_invites;
CREATE POLICY "trip_invites_insert_members" ON public.trip_invites
  FOR INSERT WITH CHECK (
    created_by_wallet = public.current_wallet() AND
    trip_id IN (
      SELECT id FROM public.trips
       WHERE member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- Invite creator can update/revoke their invite.
DROP POLICY IF EXISTS "trip_invites_update_creator" ON public.trip_invites;
CREATE POLICY "trip_invites_update_creator" ON public.trip_invites
  FOR UPDATE USING (created_by_wallet = public.current_wallet())
             WITH CHECK (created_by_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_invites TO anon, authenticated;

-- Trigger to update updated_at on trip_invites
DROP TRIGGER IF EXISTS trg_01_trip_invites_set_updated_at ON public.trip_invites;
CREATE TRIGGER trg_01_trip_invites_set_updated_at
  BEFORE UPDATE ON public.trip_invites
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ── Atomic Claim Stored Procedure ──────────────────────────────────────────
-- Atomically validates the invite capability, acquires exclusive locks on the
-- invite and trip, verifies the slot is unclaimed, and attaches the claiming
-- wallet address across trip members and expense shares.

-- ─── CLAIM TRIP INVITE RPC ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.claim_trip_invite(
  p_token_hash TEXT,
  p_claiming_wallet TEXT,
  p_selected_member_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
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
  v_idx INT;
  v_len INT;
BEGIN
  -- 1. Validate claiming wallet
  IF p_claiming_wallet IS NULL OR btrim(p_claiming_wallet) = '' THEN
    RAISE EXCEPTION 'Claiming wallet address is required';
  END IF;

  -- 2. Lock and validate the invite row
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

  -- 3. Lock and retrieve the trip row
  SELECT *
    INTO v_trip
    FROM public.trips
   WHERE id = v_invite.trip_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND: Associated trip no longer exists';
  END IF;

  -- 4. Determine target member slot
  v_target_member_id := COALESCE(v_invite.member_id, p_selected_member_id);
  v_members := COALESCE(v_trip.members, '[]'::jsonb);
  v_len := jsonb_array_length(v_members);

  IF v_target_member_id IS NOT NULL THEN
    -- Look for specified member slot
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF (v_member ->> 'id') = v_target_member_id THEN
        v_found := TRUE;
        v_target_member_name := v_member ->> 'name';
        
        -- Check if already claimed
        IF (v_member ->> 'walletAddress') IS NOT NULL AND btrim(v_member ->> 'walletAddress') <> '' THEN
          IF (v_member ->> 'walletAddress') = p_claiming_wallet THEN
            -- Idempotent retry by the same wallet
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

        -- Attach wallet
        v_updated_members := v_updated_members || jsonb_build_array(v_member || jsonb_build_object('walletAddress', p_claiming_wallet));
      ELSE
        v_updated_members := v_updated_members || jsonb_build_array(v_member);
      END IF;
    END LOOP;

    IF NOT v_found THEN
      RAISE EXCEPTION 'MEMBER_NOT_FOUND: Member slot % not found in trip', v_target_member_id;
    END IF;
  ELSE
    -- General invite with no slot pre-selected: find first unclaimed placeholder slot
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
      -- No open placeholder slots: add new member
      v_target_member_id := gen_random_uuid()::text;
      v_target_member_name := 'Member ' || (v_len + 1)::text;
      v_updated_members := v_members || jsonb_build_array(
        jsonb_build_object('id', v_target_member_id, 'name', v_target_member_name, 'walletAddress', p_claiming_wallet)
      );
    END IF;
  END IF;

  -- 5. Update trip members JSONB (triggers sync_member_wallets)
  UPDATE public.trips
     SET members = v_updated_members
   WHERE id = v_trip.id;

  -- 6. Update expenses linked to this trip
  -- Update members and shares for this member_id to attach walletAddress
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

  -- 7. Increment invite uses
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

-- ─── OPTIMISTIC CONCURRENCY RPCs ───────────────────────────────────────────────

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
AS $fn$
DECLARE
  v_current_version INT;
BEGIN
  -- We use SELECT FOR UPDATE to serialize writes on this expense
  SELECT version INTO v_current_version
    FROM public.expenses
   WHERE id = p_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;
  
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Version conflict: expected %, got %', p_expected_version, v_current_version USING ERRCODE = '40001';
  END IF;
  
  -- Perform update
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

CREATE OR REPLACE FUNCTION public.mark_share_paid(
  p_expense_id UUID,
  p_member_id TEXT,
  p_tx_hash TEXT,
  p_on_chain BOOLEAN DEFAULT true
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
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
BEGIN
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
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
      -- Update this share
      v_share := v_share || jsonb_build_object('paid', true, 'txHash', p_tx_hash);
    END IF;
    
    -- Check if all shares are paid now
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

CREATE OR REPLACE FUNCTION public.mark_shares_paid_batch(
  p_updates JSONB,
  p_tx_hash TEXT
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
AS $fn$
DECLARE
  v_update JSONB;
  v_expense_id UUID;
  v_member_id TEXT;
  v_expense public.expenses;
  v_len INT;
  v_idx INT;
  v_shares JSONB;
  v_share JSONB;
  v_updated_shares JSONB;
  v_all_paid BOOLEAN;
  v_found BOOLEAN;
  v_share_idx INT;
  v_share_len INT;
BEGIN
  v_len := jsonb_array_length(p_updates);
  
  FOR v_idx IN 0..(v_len - 1) LOOP
    v_update := p_updates -> v_idx;
    v_expense_id := (v_update ->> 'expenseId')::UUID;
    v_member_id := v_update ->> 'memberId';
    
    -- Need to acquire lock on each expense and update it
    SELECT * INTO v_expense
      FROM public.expenses
     WHERE id = v_expense_id
       FOR UPDATE;
       
    IF FOUND THEN
      v_shares := v_expense.shares;
      v_share_len := jsonb_array_length(v_shares);
      v_updated_shares := '[]'::jsonb;
      v_found := false;
      v_all_paid := true;
      
      IF v_shares IS NOT NULL AND v_share_len > 0 THEN
        FOR v_share_idx IN 0..(v_share_len - 1) LOOP
          v_share := v_shares -> v_share_idx;
          IF (v_share ->> 'memberId') = v_member_id THEN
            v_found := true;
            v_share := v_share || jsonb_build_object('paid', true, 'txHash', p_tx_hash);
          END IF;
          IF NOT (v_share ->> 'paid')::boolean THEN
            v_all_paid := false;
          END IF;
          v_updated_shares := v_updated_shares || jsonb_build_array(v_share);
        END LOOP;
        
        IF v_found THEN
          UPDATE public.expenses
             SET shares = v_updated_shares,
                 settled = v_all_paid,
                 version = version + 1
           WHERE id = v_expense_id;
        END IF;
      END IF;
    END IF;
  END LOOP;
  
  -- Return all updated expenses without duplicates
  RETURN QUERY SELECT DISTINCT * FROM public.expenses 
   WHERE id IN (
     SELECT (jsonb_array_elements(p_updates) ->> 'expenseId')::UUID
   );
END;
$fn$;


-- ─── SETTLEMENT ATTESTATIONS (oracle replay protection) ───────────────────────
create table if not exists public.settlement_attestations (
  id             uuid primary key default gen_random_uuid(),
  tx_hash        text        not null,
  expense_id     text        not null,
  member         text        not null,
  amount_stroops numeric(30) not null check (amount_stroops > 0),
  nonce          text        not null,
  expires_at     bigint      not null,
  signature      text        not null,
  created_at     timestamptz not null default now(),

  -- The concurrency guarantee: two simultaneous requests for the same claim
  -- race on this, one insert loses, and the loser re-reads the winner's row
  -- rather than minting a second attestation for the same money.
  constraint settlement_attestations_claim_unique
    unique (tx_hash, expense_id, member)
);

-- Nonces are single-use on-chain; keeping them unique here too means a
-- duplicate can never be handed out in the first place.
create unique index if not exists settlement_attestations_nonce_idx
  on public.settlement_attestations (nonce);

create index if not exists settlement_attestations_tx_hash_idx
  on public.settlement_attestations (tx_hash);

-- Written only by the oracle route via the service-role key, which bypasses
-- RLS. No policies are granted, so anon and authenticated clients cannot read
-- or write it: a client that could insert rows here could reserve allocations
-- against other people's payments.
alter table public.settlement_attestations enable row level security;

-- ============================================================================
-- Sponsored account onboarding  (issue #147 / epic #45)
-- ============================================================================

-- ─── SPONSORED ACCOUNT INDEXES ───────────────────────────────────────────────
create index if not exists sponsored_accounts_status_idx
  on public.sponsored_accounts (status);

create index if not exists sponsored_accounts_idle_idx
  on public.sponsored_accounts (status, last_active_at_ms);

create index if not exists sponsored_accounts_inviter_idx
  on public.sponsored_accounts (sponsored_by);

-- ─── TRIPS EXPENSE_IDS INDEX ─────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_trips_expense_ids       ON public.trips USING GIN (expense_ids);

-- ─── RECORD MIGRATION ────────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0003', '0003_reconcile_drifted_schema', 'reconcile_drifted_schema_v1')
ON CONFLICT (version) DO NOTHING;
