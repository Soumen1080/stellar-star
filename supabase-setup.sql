-- ============================================================================
-- Stellar-star — Supabase schema, RLS, realtime & integrity triggers
-- ============================================================================
-- Idempotent: safe to run repeatedly.
--
-- HOW TO RUN
--   Supabase Dashboard -> SQL Editor -> New Query -> paste this file -> Run.
--
-- AUTH MODEL
--   There is no Supabase Auth user. The Next.js route /api/auth/verify checks a
--   Stellar wallet signature and mints an HS256 JWT (signed with the project
--   JWT secret) carrying a `wallet_address` claim. Every policy below derives
--   identity from that claim via public.current_wallet(). Nothing trusts a
--   client-supplied header.
-- ============================================================================


-- ============================================================================
-- 0. EXTENSIONS
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid()


-- ============================================================================
-- 1. IDENTITY HELPER
-- ============================================================================
-- Reads the verified wallet address out of the request JWT. Marked STABLE so
-- the planner evaluates it once per statement and can still use the GIN and
-- btree indexes on member_wallets / created_by_wallet.

CREATE OR REPLACE FUNCTION public.current_wallet()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $fn$
  SELECT NULLIF(
    COALESCE(
      current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address',
      ''
    ),
    ''
  );
$fn$;

COMMENT ON FUNCTION public.current_wallet() IS
  'Verified Stellar wallet address from the request JWT (wallet_address claim), or NULL when unauthenticated.';


-- ============================================================================
-- 2. TABLES
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS public.users (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_address TEXT        NOT NULL UNIQUE,
  display_name   TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.expenses (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title             TEXT        NOT NULL,
  description       TEXT,
  total_amount      TEXT        NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'XLM',
  split_mode        TEXT        NOT NULL CHECK (split_mode IN ('equal', 'custom')),
  paid_by_member_id TEXT        NOT NULL,
  members           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  shares            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  settled           BOOLEAN     NOT NULL DEFAULT FALSE,
  version           INT         NOT NULL DEFAULT 1,
  created_by_wallet TEXT        NOT NULL,
  member_wallets    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.trips (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  description       TEXT,
  members           JSONB       NOT NULL DEFAULT '[]'::jsonb,
  expense_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  settled           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by_wallet TEXT        NOT NULL,
  member_wallets    TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ============================================================================
-- 3. MIGRATE PRE-EXISTING INSTALLS
-- ============================================================================
-- Brings a database created by an older revision of this file up to the shape
-- declared above, without dropping data.

DO $migrate$
BEGIN
  -- users ------------------------------------------------------------------
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users' AND column_name = 'email') THEN
    ALTER TABLE public.users DROP COLUMN email;
  END IF;

  UPDATE public.users SET display_name = 'User'
   WHERE display_name IS NULL OR btrim(display_name) = '';

  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'users'
               AND column_name = 'display_name' AND is_nullable = 'YES') THEN
    ALTER TABLE public.users ALTER COLUMN display_name SET NOT NULL;
  END IF;

  -- expenses exchange rate columns -----------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'exchange_rate') THEN
    ALTER TABLE public.expenses ADD COLUMN exchange_rate TEXT;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'exchange_rate_timestamp') THEN
    ALTER TABLE public.expenses ADD COLUMN exchange_rate_timestamp TIMESTAMPTZ;
  END IF;

  -- expenses version column ------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'version') THEN
    ALTER TABLE public.expenses ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;

  -- expenses version column ------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'version') THEN
    ALTER TABLE public.expenses ADD COLUMN version INT NOT NULL DEFAULT 1;
  END IF;

  -- expenses / trips wallet columns ----------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'created_by_wallet') THEN
    ALTER TABLE public.expenses ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'expenses' AND column_name = 'member_wallets') THEN
    ALTER TABLE public.expenses ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'created_by_wallet') THEN
    ALTER TABLE public.trips ADD COLUMN created_by_wallet TEXT NOT NULL DEFAULT '';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'member_wallets') THEN
    ALTER TABLE public.trips ADD COLUMN member_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
  END IF;
END
$migrate$;


-- ============================================================================
-- 4. INTEGRITY TRIGGERS
-- ============================================================================

-- 4a. updated_at ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$fn$;

-- 4b. Derive member_wallets from the members JSONB --------------------------
-- The access-control array is computed by the database, never trusted from the
-- client. This guarantees member_wallets can never drift out of sync with the
-- members list -- that drift is exactly what silently makes rows invisible
-- under RLS and looks to a user like "my data did not load".
CREATE OR REPLACE FUNCTION public.sync_member_wallets()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  wallets TEXT[];
BEGIN
  WITH extracted AS (
    SELECT NULLIF(btrim(COALESCE(m ->> 'walletAddress', '')), '') AS w
    FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) AS m
    UNION
    SELECT NULLIF(btrim(COALESCE(s ->> 'walletAddress', '')), '') AS w
    FROM jsonb_array_elements(
      COALESCE(to_jsonb(NEW) -> 'shares', '[]'::jsonb)
    ) AS s
  )
  SELECT COALESCE(array_agg(DISTINCT w), ARRAY[]::TEXT[])
    INTO wallets
    FROM extracted
   WHERE w IS NOT NULL;

  -- The creator always retains access to their own row.
  IF NEW.created_by_wallet IS NOT NULL
     AND NEW.created_by_wallet <> ''
     AND NOT (NEW.created_by_wallet = ANY (wallets)) THEN
    wallets := array_prepend(NEW.created_by_wallet, wallets);
  END IF;

  NEW.member_wallets := wallets;
  RETURN NEW;
END;
$fn$;

-- 4c. Identity columns are immutable ----------------------------------------
-- Any member may update a shared row; none of them may take over its
-- ownership, so deletion rights stay with the original creator.
CREATE OR REPLACE FUNCTION public.freeze_row_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  old_json JSONB;
  new_json JSONB;
BEGIN
  old_json := to_jsonb(OLD);
  new_json := to_jsonb(NEW);

  new_json := new_json
    || jsonb_build_object('id', old_json -> 'id')
    || jsonb_build_object('created_at', old_json -> 'created_at')
    || jsonb_build_object('created_by_wallet', old_json -> 'created_by_wallet');

  IF old_json ? 'exchange_rate' AND (old_json ->> 'exchange_rate') IS NOT NULL THEN
    new_json := new_json
      || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
      || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp')
      || jsonb_build_object('total_amount', old_json -> 'total_amount')
      || jsonb_build_object('currency', old_json -> 'currency');
  END IF;

  RETURN jsonb_populate_record(NEW, new_json);
END;
$fn$;

-- 4d. Validate shares sum ---------------------------------------------------
-- Ensure the sum of amounts within the shares JSONB array equals total_amount.
CREATE OR REPLACE FUNCTION public.validate_expense_shares()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  total NUMERIC;
  shares_sum NUMERIC;
BEGIN
  BEGIN
    total := NEW.total_amount::NUMERIC;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION 'total_amount must be a valid numeric string';
  END;

  SELECT COALESCE(SUM((s ->> 'amount')::NUMERIC), 0)
    INTO shares_sum
    FROM jsonb_array_elements(COALESCE(NEW.shares, '[]'::jsonb)) AS s
   WHERE s ->> 'amount' IS NOT NULL;

  IF shares_sum <> total THEN
    RAISE EXCEPTION 'Sum of expense shares (%) does not equal total_amount (%)', shares_sum, total;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS users_set_updated_at         ON public.users;
DROP TRIGGER IF EXISTS expenses_set_updated_at      ON public.expenses;
DROP TRIGGER IF EXISTS trips_set_updated_at         ON public.trips;
DROP TRIGGER IF EXISTS expenses_sync_member_wallets ON public.expenses;
DROP TRIGGER IF EXISTS trips_sync_member_wallets    ON public.trips;
DROP TRIGGER IF EXISTS expenses_freeze_identity     ON public.expenses;
DROP TRIGGER IF EXISTS trips_freeze_identity        ON public.trips;
DROP TRIGGER IF EXISTS expenses_validate_shares     ON public.expenses;
-- Trigger names used by earlier revisions of this file.
DROP TRIGGER IF EXISTS update_users_updated_at      ON public.users;
DROP TRIGGER IF EXISTS update_expenses_updated_at   ON public.expenses;
DROP TRIGGER IF EXISTS update_trips_updated_at      ON public.trips;
DROP TRIGGER IF EXISTS trg_01_users_set_updated_at  ON public.users;
DROP TRIGGER IF EXISTS trg_01_expenses_freeze_identity ON public.expenses;
DROP TRIGGER IF EXISTS trg_02_expenses_sync_member_wallets ON public.expenses;
DROP TRIGGER IF EXISTS trg_03_expenses_validate_shares ON public.expenses;
DROP TRIGGER IF EXISTS trg_04_expenses_set_updated_at ON public.expenses;
DROP TRIGGER IF EXISTS trg_01_trips_freeze_identity ON public.trips;
DROP TRIGGER IF EXISTS trg_02_trips_sync_member_wallets ON public.trips;
DROP TRIGGER IF EXISTS trg_03_trips_set_updated_at ON public.trips;

-- Users
CREATE TRIGGER trg_01_users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Expenses Pipeline:
-- 1. Freeze identity -> 2. Sync member wallets -> 3. Validate shares -> 4. Set updated_at
CREATE TRIGGER trg_01_expenses_freeze_identity
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

CREATE TRIGGER trg_02_expenses_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

CREATE TRIGGER trg_03_expenses_validate_shares
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_shares();

CREATE TRIGGER trg_04_expenses_set_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Trips Pipeline:
-- 1. Freeze identity -> 2. Sync member wallets -> 3. Set updated_at
CREATE TRIGGER trg_01_trips_freeze_identity
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

CREATE TRIGGER trg_02_trips_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

CREATE TRIGGER trg_03_trips_set_updated_at
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


-- ============================================================================
-- 5. INDEXES
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_users_wallet_address    ON public.users (wallet_address);
CREATE INDEX IF NOT EXISTS idx_users_created_at        ON public.users (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_member_wallets ON public.expenses USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_expenses_creator        ON public.expenses (created_by_wallet);
CREATE INDEX IF NOT EXISTS idx_expenses_created_at     ON public.expenses (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_settled        ON public.expenses (settled);

CREATE INDEX IF NOT EXISTS idx_trips_member_wallets    ON public.trips USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_trips_creator           ON public.trips (created_by_wallet);
CREATE INDEX IF NOT EXISTS idx_trips_created_at        ON public.trips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_settled           ON public.trips (settled);
CREATE INDEX IF NOT EXISTS idx_trips_expense_ids       ON public.trips USING GIN (expense_ids);


-- ============================================================================
-- 6. ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.users    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips    ENABLE ROW LEVEL SECURITY;

-- Drop every existing policy on these tables so a re-run never leaves behind a
-- stale rule under a name this file no longer uses.
DO $drop_policies$
DECLARE
  p RECORD;
BEGIN
  FOR p IN
    SELECT policyname, tablename
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('users', 'expenses', 'trips')
  LOOP
    EXECUTE format('DROP POLICY %I ON public.%I', p.policyname, p.tablename);
  END LOOP;
END
$drop_policies$;

-- ── users ──────────────────────────────────────────────────────────────────
-- Profiles are readable by everyone so a member picker can resolve a wallet
-- address to a display name. Only the owning wallet may write its own row.
CREATE POLICY "users_select_all" ON public.users
  FOR SELECT USING (true);

CREATE POLICY "users_insert_self" ON public.users
  FOR INSERT WITH CHECK (wallet_address = public.current_wallet());

CREATE POLICY "users_update_self" ON public.users
  FOR UPDATE USING      (wallet_address = public.current_wallet())
             WITH CHECK (wallet_address = public.current_wallet());

CREATE POLICY "users_delete_self" ON public.users
  FOR DELETE USING (wallet_address = public.current_wallet());

-- ── expenses ───────────────────────────────────────────────────────────────
-- `@> ARRAY[...]` (rather than `= ANY(...)`) is the GIN-indexable form.
CREATE POLICY "expenses_select_members" ON public.expenses
  FOR SELECT USING (member_wallets @> ARRAY[public.current_wallet()]);

CREATE POLICY "expenses_insert_creator" ON public.expenses
  FOR INSERT WITH CHECK (created_by_wallet = public.current_wallet());

CREATE POLICY "expenses_update_members" ON public.expenses
  FOR UPDATE USING      (member_wallets @> ARRAY[public.current_wallet()])
             WITH CHECK (member_wallets @> ARRAY[public.current_wallet()]);

CREATE POLICY "expenses_delete_creator" ON public.expenses
  FOR DELETE USING (created_by_wallet = public.current_wallet());

-- ── trips ──────────────────────────────────────────────────────────────────
CREATE POLICY "trips_select_members" ON public.trips
  FOR SELECT USING (member_wallets @> ARRAY[public.current_wallet()]);

CREATE POLICY "trips_insert_creator" ON public.trips
  FOR INSERT WITH CHECK (created_by_wallet = public.current_wallet());

CREATE POLICY "trips_update_members" ON public.trips
  FOR UPDATE USING      (member_wallets @> ARRAY[public.current_wallet()])
             WITH CHECK (member_wallets @> ARRAY[public.current_wallet()]);

CREATE POLICY "trips_delete_creator" ON public.trips
  FOR DELETE USING (created_by_wallet = public.current_wallet());


-- ============================================================================
-- 7. GRANTS
-- ============================================================================
-- RLS decides which rows are visible; these grants decide whether the table is
-- reachable at all. Every minted wallet JWT carries role=authenticated.

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.users    TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expenses TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.trips    TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_wallet() TO anon, authenticated;


-- ============================================================================
-- 8. REALTIME
-- ============================================================================
-- Realtime replays row changes through these same RLS policies, so a client
-- only receives rows its wallet is already allowed to read.

DO $realtime$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'expenses') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_publication_tables
                 WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trips') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trips;
  END IF;
END
$realtime$;

-- A DELETE event carries only the primary key unless the table replicates the
-- whole old row, and the RLS check on a delete needs member_wallets to be
-- present in that old row.
ALTER TABLE public.expenses REPLICA IDENTITY FULL;
ALTER TABLE public.trips    REPLICA IDENTITY FULL;


-- ============================================================================
-- 9. BACKFILL
-- ============================================================================
-- Recompute member_wallets for rows written before the sync trigger existed.

UPDATE public.expenses SET members = members;
UPDATE public.trips    SET members = members;


-- ============================================================================
-- 10. RELOAD THE POSTGREST SCHEMA CACHE
-- ============================================================================
-- Without this, freshly created tables keep returning PGRST205
-- ("Could not find the table in the schema cache") until PostgREST notices
-- them on its own.

NOTIFY pgrst, 'reload schema';


-- ============================================================================
-- 11. VERIFICATION
-- ============================================================================

SELECT tablename, rowsecurity AS rls_enabled
  FROM pg_tables
 WHERE schemaname = 'public' AND tablename IN ('users', 'expenses', 'trips')
 ORDER BY tablename;

SELECT tablename, policyname, cmd
  FROM pg_policies
 WHERE schemaname = 'public' AND tablename IN ('users', 'expenses', 'trips')
 ORDER BY tablename, policyname;

SELECT tablename AS realtime_enabled_table
  FROM pg_publication_tables
 WHERE pubname = 'supabase_realtime' AND schemaname = 'public'
 ORDER BY tablename;

-- ============================================================================
-- Settlement attestation ledger  (issue #144 / epic #42)
-- ============================================================================
-- The oracle's record of what it has already attested.
--
-- The contract's nonce burn makes each attestation single-use, but it cannot
-- see that two claims share a transaction. Without this table, one real 10 XLM
-- payment could earn a separate valid attestation per expense. The unique
-- constraint below is what makes that impossible across concurrent requests
-- and across multiple oracle instances.

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
-- Sponsorship locks the sponsor's XLM durably rather than spending it, so these
-- tables are the sponsor's balance sheet: every active row is an open liability
-- until revoked. Without a shared store the cap is per-process, which on a
-- multi-instance deployment is N times the cap the operator believes they set.

create table if not exists public.sponsored_accounts (
  account          text        primary key,
  locked_stroops   numeric(30) not null check (locked_stroops > 0),
  status           text        not null default 'active'
                               check (status in ('active', 'revoked', 'reclaimed')),
  created_at_ms    bigint      not null,
  last_active_at_ms bigint     not null,
  -- The wallet whose invite created this sponsorship. Abuse resistance keys on
  -- the inviter, so this is the link back to who bears the cost.
  sponsored_by     text        not null,
  revoked_at_ms    bigint,
  created_at       timestamptz not null default now()
);

-- The cap is computed by summing active rows, so this index is what keeps that
-- read cheap enough to run on every sponsorship request.
create index if not exists sponsored_accounts_status_idx
  on public.sponsored_accounts (status);

create index if not exists sponsored_accounts_idle_idx
  on public.sponsored_accounts (status, last_active_at_ms);

create index if not exists sponsored_accounts_inviter_idx
  on public.sponsored_accounts (sponsored_by);

-- Per-inviter quota and cooldown records.
create table if not exists public.sponsorship_invites (
  id            uuid        primary key default gen_random_uuid(),
  inviter       text        not null,
  invitee       text        not null,
  created_at_ms bigint      not null,
  created_at    timestamptz not null default now(),

  -- One inviter cannot sponsor the same account twice, and concurrent
  -- duplicate requests collide here rather than each consuming a quota slot.
  constraint sponsorship_invites_pair_unique unique (inviter, invitee)
);

create index if not exists sponsorship_invites_inviter_idx
  on public.sponsorship_invites (inviter, created_at_ms desc);

-- Written only by the onboarding routes via the service-role key, which
-- bypasses RLS. No policies are granted: a client that could insert or delete
-- rows here could forge quota headroom, or release a sponsorship it does not
-- own.
alter table public.sponsored_accounts enable row level security;
alter table public.sponsorship_invites enable row level security;

-- ============================================================================
-- Trip Invitations & Capability-Based Member Claims (Issue #171 / Issue #65)
-- ============================================================================
-- Allows users to add friends by name and settle up later via capability tokens.
--
-- Security model:
-- 1. Tokens are 256-bit high-entropy unguessable secrets; only SHA-256 hashes
--    are stored in the database.
-- 2. Claiming is verified against authenticated wallet identity and executed
--    atomically with SELECT ... FOR UPDATE, guaranteeing a member slot is claimed
--    at most once under concurrent attempts.
-- 3. Claiming automatically re-triggers sync_member_wallets, preserving the
--    single GIN-indexed RLS authorization mechanism with zero privilege escalation.

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
CREATE POLICY "trip_invites_select_members" ON public.trip_invites
  FOR SELECT USING (
    trip_id IN (
      SELECT id FROM public.trips
       WHERE member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- Trip members can create invites for their trip.
CREATE POLICY "trip_invites_insert_members" ON public.trip_invites
  FOR INSERT WITH CHECK (
    created_by_wallet = public.current_wallet() AND
    trip_id IN (
      SELECT id FROM public.trips
       WHERE member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- Invite creator can update/revoke their invite.
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

GRANT EXECUTE ON FUNCTION public.claim_trip_invite(TEXT, TEXT, TEXT) TO anon, authenticated;

-- ============================================================================
-- 12. CONCURRENT EXPENSE EDITING (ISSUE #203)
-- ============================================================================

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

GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) TO anon, authenticated;

-- ============================================================================
-- 12. CONCURRENT EXPENSE EDITING (ISSUE #203)
-- ============================================================================

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

GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) TO anon, authenticated;

-- ─── RECORD APPLIED MIGRATIONS ───────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES
  ('0001', '0001_baseline', 'baseline_initial_checksum'),
  ('0002', '0002_explicit_trigger_pipeline', 'trigger_pipeline_checksum'),
  ('0003', '0003_trip_invitations_capabilities', 'trip_invites_capability_checksum')
ON CONFLICT (version) DO NOTHING;


