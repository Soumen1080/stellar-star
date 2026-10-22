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

CREATE TABLE IF NOT EXISTS public.deleted_accounts (
  wallet_address TEXT PRIMARY KEY,
  deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason         TEXT NOT NULL DEFAULT 'user_request'
);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
  ON public.deleted_accounts (deleted_at DESC);

ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deleted_accounts_select_all" ON public.deleted_accounts
  FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION public.current_wallet()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $fn$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.deleted_accounts
       WHERE wallet_address = NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
    ) THEN NULL
    ELSE NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
  END;
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
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  voided            BOOLEAN     NOT NULL DEFAULT FALSE,
  voided_at         TIMESTAMPTZ,
  voided_by_wallet  TEXT,
  void_reason       TEXT,
  correction_of_expense_id UUID REFERENCES public.expenses(id) ON DELETE RESTRICT,
  correction_type   TEXT,
  correction_reason TEXT
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
  workspace         JSONB       NOT NULL DEFAULT '{"itinerary":[],"checklists":[],"bookings":[]}'::jsonb,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.auth_challenges (
  nonce          TEXT PRIMARY KEY,
  address        TEXT NOT NULL,
  expiration     BIGINT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_challenges_address_idx ON public.auth_challenges (address);
-- Expiry sweeps scan by expiration; rate-limit windows by window_start.
-- These exist in migrations/0001_baseline.sql and are mirrored here so both
-- provisioning paths converge on the same indexes.
CREATE INDEX IF NOT EXISTS auth_challenges_expiration_idx ON public.auth_challenges (expiration);

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  key            TEXT PRIMARY KEY,
  count          INT NOT NULL DEFAULT 1,
  window_start   BIGINT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON public.auth_rate_limits (window_start);

ALTER TABLE public.auth_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_rate_limits ENABLE ROW LEVEL SECURITY;


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

  -- expenses FX provenance columns (#323, migrations/0010) ------------------
  ALTER TABLE public.expenses
    ADD COLUMN IF NOT EXISTS entered_amount       TEXT,
    ADD COLUMN IF NOT EXISTS exchange_rate_source TEXT,
    ADD COLUMN IF NOT EXISTS settlement_asset     TEXT NOT NULL DEFAULT 'native';

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

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'trips' AND column_name = 'workspace') THEN
    ALTER TABLE public.trips ADD COLUMN workspace JSONB NOT NULL DEFAULT '{"itinerary":[],"checklists":[],"bookings":[]}'::jsonb;
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

  -- The original fiat/XLM snapshot is part of the debt. Freeze it even when
  -- exchange_rate is NULL (for native XLM expenses), and freeze the source and
  -- timestamp together with the rate so the provenance cannot be rewritten.
  new_json := new_json
    || jsonb_build_object('total_amount', old_json -> 'total_amount')
    || jsonb_build_object('currency', old_json -> 'currency')
    || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
    || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp')
    || jsonb_build_object('exchange_rate_source', old_json -> 'exchange_rate_source')
    || jsonb_build_object('entered_amount', old_json -> 'entered_amount')
    || jsonb_build_object('settlement_asset', old_json -> 'settlement_asset');

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
CREATE INDEX IF NOT EXISTS idx_expenses_creator_created_at
  ON public.expenses (created_by_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expenses_settled_created_at
  ON public.expenses (settled, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trips_member_wallets    ON public.trips USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_trips_creator           ON public.trips (created_by_wallet);
CREATE INDEX IF NOT EXISTS idx_trips_created_at        ON public.trips (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_settled           ON public.trips (settled);
CREATE INDEX IF NOT EXISTS idx_trips_expense_ids       ON public.trips USING GIN (expense_ids);
CREATE INDEX IF NOT EXISTS idx_trips_creator_created_at
  ON public.trips (created_by_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_trips_settled_created_at
  ON public.trips (settled, created_at DESC);

CREATE INDEX IF NOT EXISTS auth_challenges_address_created_at_idx
  ON public.auth_challenges (address, created_at ASC);


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

-- Reconcile the legacy sponsored_accounts shape used by early installs before
-- creating indexes on the current ledger columns.
DO $sponsored_accounts_shape$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sponsored_accounts'
       AND column_name = 'account_id'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sponsored_accounts'
       AND column_name = 'account'
  ) THEN
    ALTER TABLE public.sponsored_accounts RENAME COLUMN account_id TO account;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sponsored_accounts'
       AND column_name = 'sponsor'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sponsored_accounts'
       AND column_name = 'sponsored_by'
  ) THEN
    ALTER TABLE public.sponsored_accounts RENAME COLUMN sponsor TO sponsored_by;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sponsored_accounts'
       AND column_name = 'operation_id'
  ) THEN
    ALTER TABLE public.sponsored_accounts ALTER COLUMN operation_id DROP NOT NULL;
  END IF;
END
$sponsored_accounts_shape$;

ALTER TABLE public.sponsored_accounts
  ADD COLUMN IF NOT EXISTS locked_stroops NUMERIC(30) NOT NULL DEFAULT 1
    CHECK (locked_stroops > 0),
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'revoked', 'reclaimed')),
  ADD COLUMN IF NOT EXISTS created_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS last_active_at_ms BIGINT,
  ADD COLUMN IF NOT EXISTS sponsored_by TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS revoked_at_ms BIGINT;

UPDATE public.sponsored_accounts
   SET created_at_ms = COALESCE(created_at_ms, (extract(epoch FROM created_at) * 1000)::BIGINT),
       last_active_at_ms = COALESCE(last_active_at_ms, (extract(epoch FROM created_at) * 1000)::BIGINT)
 WHERE created_at_ms IS NULL OR last_active_at_ms IS NULL;

ALTER TABLE public.sponsored_accounts
  ALTER COLUMN created_at_ms SET NOT NULL,
  ALTER COLUMN last_active_at_ms SET NOT NULL;

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
CREATE INDEX IF NOT EXISTS idx_trip_invites_trip_created_at
  ON public.trip_invites (trip_id, created_at DESC);

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
BEGIN
  -- 1. Validate claiming wallet
  IF p_claiming_wallet IS NULL OR btrim(p_claiming_wallet) = '' THEN
    RAISE EXCEPTION 'Claiming wallet address is required';
  END IF;
  v_normalized_wallet := upper(btrim(p_claiming_wallet));

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

  -- Validate expected trip id if provided
  IF p_expected_trip_id IS NOT NULL AND btrim(p_expected_trip_id) <> '' THEN
    IF v_invite.trip_id <> btrim(p_expected_trip_id) THEN
      RAISE EXCEPTION 'TRIP_MISMATCH: Invitation token does not belong to the specified trip';
    END IF;
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

  -- 5. Single-membership check: ensure claiming wallet does not already hold another member slot in this trip
  FOR v_idx IN 0..(v_len - 1) LOOP
    v_member := v_members -> v_idx;
    v_existing_wallet := upper(btrim(COALESCE(v_member ->> 'walletAddress', '')));
    IF v_existing_wallet <> '' AND v_existing_wallet = v_normalized_wallet THEN
      -- If the wallet already belongs to the target member slot, it's an idempotent retry
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
    -- Look for specified member slot
    FOR v_idx IN 0..(v_len - 1) LOOP
      v_member := v_members -> v_idx;
      IF (v_member ->> 'id') = v_target_member_id THEN
        v_found := TRUE;
        v_target_member_name := v_member ->> 'name';
        
        -- Check if already claimed
        IF (v_member ->> 'walletAddress') IS NOT NULL AND btrim(v_member ->> 'walletAddress') <> '' THEN
          IF upper(btrim(v_member ->> 'walletAddress')) = v_normalized_wallet THEN
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

  -- 6. Update trip members JSONB (triggers sync_member_wallets)
  UPDATE public.trips
     SET members = v_updated_members
   WHERE id = v_trip.id;

  -- 7. Update expenses linked to this trip
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

  -- 8. Increment invite uses
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

GRANT EXECUTE ON FUNCTION public.claim_trip_invite(TEXT, TEXT, TEXT, TEXT) TO anon, authenticated;

-- ── Public Invite Verification (ISSUE #221) ─────────────────────────────────
-- Receiving an invite link happens before you are a member of the trip, and
-- usually before you have a session at all. Both trip_invites_select_members
-- and trips_select_members gate SELECT on member_wallets containing
-- current_wallet(), so the prospective member fails both: unauthenticated,
-- current_wallet() is NULL; signed in, they are not yet in member_wallets.
-- Reading the invite directly therefore always returned zero rows, which the
-- app surfaced as "Invalid or unrecognized invitation link."
--
-- Relaxing those policies is not an option — a policy loose enough for a
-- stranger to read one invite row is loose enough to enumerate them all. This
-- function answers exactly one question ("is this token hash valid, and what may
-- its bearer see?") and returns only the fields /join renders. Possession of the
-- token is the capability; nothing else is reachable through it.
CREATE OR REPLACE FUNCTION public.verify_trip_invite(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
-- Pinned so a SECURITY DEFINER body can never resolve a name through a
-- caller-controlled schema.
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

  -- 1. Resolve the capability. token_hash is UNIQUE and the caller only ever
  --    holds the pre-image, so this is the one lookup the token authorizes.
  SELECT id, trip_id, member_id, created_by_wallet, expires_at, max_uses, uses, revoked
    INTO v_invite
    FROM public.trip_invites
   WHERE token_hash = p_token_hash;

  -- Same error for "no such token" as for a malformed one: a caller guessing
  -- hashes learns nothing from the difference.
  IF NOT FOUND THEN
    RAISE EXCEPTION 'INVITE_NOT_FOUND: Invalid or unrecognized invitation link';
  END IF;

  -- 2. Validity, reported distinctly on purpose: someone holding a real-but-
  --    expired link needs to know to ask for a new one.
  IF v_invite.revoked THEN
    RAISE EXCEPTION 'INVITE_REVOKED: This invitation has been revoked';
  END IF;

  IF v_invite.expires_at <= NOW() THEN
    RAISE EXCEPTION 'INVITE_EXPIRED: This invitation has expired';
  END IF;

  IF v_invite.uses >= v_invite.max_uses THEN
    RAISE EXCEPTION 'INVITE_EXHAUSTED: This invitation has already reached its maximum uses';
  END IF;

  -- 3. Trip metadata: only the columns /join renders.
  SELECT id, name, description, members
    INTO v_trip
    FROM public.trips
   WHERE id = v_invite.trip_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'TRIP_NOT_FOUND: The trip associated with this invite no longer exists';
  END IF;

  -- 4. Unclaimed slots reduced to {id, name}. The raw members array carries every
  --    existing member's wallet address; projecting here means an invite link can
  --    never harvest the roster of a trip you have not joined.
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id', m ->> 'id', 'name', m ->> 'name')), '[]'::jsonb)
    INTO v_unclaimed
    FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS m
   WHERE (m ->> 'walletAddress') IS NULL
      OR btrim(m ->> 'walletAddress') = '';

  -- 5. When the invite names a specific slot, surface that slot's display name.
  IF v_invite.member_id IS NOT NULL THEN
    SELECT m ->> 'name'
      INTO v_member_name
      FROM jsonb_array_elements(COALESCE(v_trip.members, '[]'::jsonb)) AS m
     WHERE (m ->> 'id') = v_invite.member_id
     LIMIT 1;
  END IF;

  -- The validity flags are false by construction: every true case raised above.
  -- Returned anyway because TripInviteSummary declares them.
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
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_current_version INT;
  v_expense public.expenses;
  v_caller TEXT := public.current_wallet();
BEGIN
  -- We use SELECT FOR UPDATE to serialize writes on this expense
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF v_caller IS NOT NULL AND NOT (v_expense.member_wallets @> ARRAY[v_caller]) THEN
    RAISE EXCEPTION 'Unauthorized: only expense members can update this expense' USING ERRCODE = '42501';
  END IF;

  v_current_version := v_expense.version;
  
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

REVOKE EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) TO authenticated;

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
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_current_version INT;
  v_expense public.expenses;
  v_caller TEXT := public.current_wallet();
BEGIN
  -- We use SELECT FOR UPDATE to serialize writes on this expense
  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_id
     FOR UPDATE;
     
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found';
  END IF;

  IF v_caller IS NOT NULL AND NOT (v_expense.member_wallets @> ARRAY[v_caller]) THEN
    RAISE EXCEPTION 'Unauthorized: only expense members can update this expense' USING ERRCODE = '42501';
  END IF;

  v_current_version := v_expense.version;
  
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

REVOKE EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.update_expense_versioned(UUID, INT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_share_paid(UUID, TEXT, TEXT, BOOLEAN) TO authenticated;
REVOKE EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.mark_shares_paid_batch(JSONB, TEXT) TO authenticated;

-- ============================================================================
-- 13. MULTI-INSTANCE AUTH & RATE LIMITING (ISSUE #204)
-- ============================================================================

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
SET search_path = public, pg_temp
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

GRANT EXECUTE ON FUNCTION public.record_auth_challenge(TEXT, TEXT, BIGINT, INT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_auth_challenge(TEXT, TEXT, BIGINT, BIGINT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_auth_rate_limit(TEXT, INT, BIGINT, BIGINT) TO anon, authenticated;

-- ============================================================================
-- Durable settlement intents  (docs/DESIGN_EXACTLY_ONCE_SETTLEMENT.md)
-- ============================================================================
-- The store that makes settlement exactly-once: an intent is recorded here
-- before any irreversible action, so a debt cannot be paid twice, a crash
-- mid-submit is recoverable, and a new device converges on in-flight state.

CREATE TABLE IF NOT EXISTS public.settlement_intents (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Deterministic per (trip, expense, member): see deriveIdempotencyKey().
  -- The UNIQUE constraint is the concurrency guarantee — two simultaneous
  -- attempts to settle one debt collide here and exactly one proceeds.
  idempotency_key   TEXT        NOT NULL,
  request_id        UUID        NOT NULL DEFAULT gen_random_uuid(),

  trip_id           TEXT        NOT NULL,
  expense_id        TEXT        NOT NULL,
  member_id         TEXT        NOT NULL,

  -- Wallet being paid, and the wallet that owes it.
  payer_wallet      TEXT        NOT NULL,
  member_wallet     TEXT        NOT NULL,

  -- Decimal string, never a float: money must not pass through binary floating
  -- point anywhere in this system.
  amount            TEXT        NOT NULL,
  currency          TEXT        NOT NULL DEFAULT 'XLM',

  status            TEXT        NOT NULL DEFAULT 'pending'
                                CHECK (status IN ('pending', 'submitting', 'submitted',
                                                  'recorded', 'failed', 'cancelled')),

  -- Filled in as the transaction progresses.
  tx_hash           TEXT,
  ledger            BIGINT,
  on_chain          BOOLEAN     NOT NULL DEFAULT FALSE,
  error_message     TEXT,

  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Intents are short-lived; the client sets this ~15 minutes out.
  expires_at        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 minutes'),

  CONSTRAINT settlement_intents_idempotency_key_unique UNIQUE (idempotency_key)
);

-- fetchActiveSettlementIntents filters on (member_wallet, status).
CREATE INDEX IF NOT EXISTS settlement_intents_member_status_idx
  ON public.settlement_intents (member_wallet, status);

CREATE INDEX IF NOT EXISTS settlement_intents_member_status_created_at_idx
  ON public.settlement_intents (member_wallet, status, created_at DESC);

-- fetchSettlementIntentByExpenseAndMember orders by created_at within the pair.
CREATE INDEX IF NOT EXISTS settlement_intents_expense_member_idx
  ON public.settlement_intents (expense_id, member_id, created_at DESC);

CREATE INDEX IF NOT EXISTS settlement_intents_request_id_idx
  ON public.settlement_intents (request_id);

CREATE UNIQUE INDEX IF NOT EXISTS settlement_intents_tx_expense_member_asset_idx
  ON public.settlement_intents (tx_hash, expense_id, member_id, currency)
  WHERE tx_hash IS NOT NULL;

-- ─── UPDATED_AT TRIGGER ──────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS settlement_intents_set_updated_at ON public.settlement_intents;
CREATE TRIGGER settlement_intents_set_updated_at
  BEFORE UPDATE ON public.settlement_intents
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
-- An intent is visible to, and writable by, the two wallets it is between: the
-- one that owes the money and the one being paid. Nobody else can see that a
-- settlement is in flight, and nobody else can cancel or re-point one.
ALTER TABLE public.settlement_intents ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS settlement_intents_select_party ON public.settlement_intents;
CREATE POLICY settlement_intents_select_party ON public.settlement_intents
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS settlement_intents_insert_own ON public.settlement_intents;
CREATE POLICY settlement_intents_insert_own ON public.settlement_intents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS settlement_intents_update_party ON public.settlement_intents;
CREATE POLICY settlement_intents_update_party ON public.settlement_intents
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS settlement_intents_delete_owner ON public.settlement_intents;
CREATE POLICY settlement_intents_delete_owner ON public.settlement_intents
  FOR DELETE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
  );

-- ============================================================================
-- Export audit log (#324, migrations/0011)
-- ============================================================================
-- Append-only record of every portable-archive export request.

CREATE TABLE IF NOT EXISTS public.export_audit_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_wallet   TEXT        NOT NULL,
  export_kind    TEXT        NOT NULL CHECK (export_kind IN ('archive')),
  status         TEXT        NOT NULL CHECK (status IN ('served', 'rate_limited', 'forbidden', 'failed')),
  trip_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  trip_count     INT         NOT NULL DEFAULT 0 CHECK (trip_count >= 0),
  expense_count  INT         NOT NULL DEFAULT 0 CHECK (expense_count >= 0),
  byte_size      INT         NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- SHA-256 of the archive body, so a file can later be matched to its record.
  content_sha256 TEXT,
  request_id     TEXT,
  -- Salted hash, not the raw IP: enough to spot abuse, not to track people.
  client_ip_hash TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_audit_events_actor_created_at
  ON public.export_audit_events (actor_wallet, created_at DESC);

ALTER TABLE public.export_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_audit_events_select_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_select_actor ON public.export_audit_events
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS export_audit_events_insert_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_insert_actor ON public.export_audit_events
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.export_audit_events TO authenticated;

-- ─── 14. IDEMPOTENCY RECORDS (#312) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.idempotency_records (
  key                 TEXT NOT NULL,
  wallet_address      TEXT NOT NULL,
  endpoint            TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  status              TEXT NOT NULL CHECK (status IN ('pending', 'completed', 'failed')),
  response_status     INT,
  response_body       JSONB,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until        TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 minute'),
  CONSTRAINT idempotency_records_wallet_key_unique UNIQUE (wallet_address, key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_lookup
  ON public.idempotency_records (wallet_address, key);

CREATE INDEX IF NOT EXISTS idx_idempotency_records_created_at
  ON public.idempotency_records (created_at DESC);

ALTER TABLE public.idempotency_records ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS idempotency_records_select_self ON public.idempotency_records;
CREATE POLICY idempotency_records_select_self ON public.idempotency_records
  FOR SELECT USING (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS idempotency_records_insert_self ON public.idempotency_records;
CREATE POLICY idempotency_records_insert_self ON public.idempotency_records
  FOR INSERT WITH CHECK (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS idempotency_records_update_self ON public.idempotency_records;
CREATE POLICY idempotency_records_update_self ON public.idempotency_records
  FOR UPDATE USING (wallet_address = public.current_wallet())
             WITH CHECK (wallet_address = public.current_wallet());

DROP POLICY IF EXISTS idempotency_records_delete_self ON public.idempotency_records;
CREATE POLICY idempotency_records_delete_self ON public.idempotency_records
  FOR DELETE USING (wallet_address = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.idempotency_records TO authenticated;

-- ─── RECORD APPLIED MIGRATIONS ───────────────────────────────────────────────

-- ============================================================================
-- Configurable trip roles and granular permissions (migration 0008)
-- ============================================================================
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
CREATE INDEX IF NOT EXISTS trip_role_audit_trip_created_at_idx ON public.trip_role_audit (trip_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.trip_member_role(p_trip_id UUID, p_wallet TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(member ->> 'role', CASE WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet)) THEN 'owner' ELSE 'contributor' END)
  FROM public.trips t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
  WHERE t.id = p_trip_id
    AND upper(btrim(COALESCE(p_wallet, ''))) = upper(btrim(COALESCE(public.current_wallet(), '')))
    AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(COALESCE(p_wallet, '')))
  LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.trip_has_permission(p_trip_id UUID, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_wallet TEXT := public.current_wallet(); v_role TEXT; v_permissions JSONB;
BEGIN
  IF v_wallet IS NULL OR p_permission IS NULL OR p_permission NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage') THEN RETURN FALSE; END IF;
  SELECT COALESCE(member ->> 'role', CASE WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet)) THEN 'owner' ELSE 'contributor' END), COALESCE(member -> 'customPermissions', '[]'::jsonb)
    INTO v_role, v_permissions FROM public.trips t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
   WHERE t.id = p_trip_id AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(v_wallet)) LIMIT 1;
  IF v_role IN ('owner','organizer') THEN RETURN TRUE; END IF;
  IF v_role = 'contributor' THEN RETURN p_permission IN ('expenses.manage','receipts.manage','exports.view'); END IF;
  IF v_role = 'viewer' THEN RETURN p_permission = 'exports.view'; END IF;
  IF v_role = 'custom' THEN RETURN v_permissions ? p_permission; END IF;
  RETURN FALSE;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.expense_has_permission(p_expense_id UUID, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_wallet TEXT := public.current_wallet();
BEGIN
  IF v_wallet IS NULL THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public.trips t WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT] AND public.trip_has_permission(t.id, p_permission)) THEN RETURN TRUE; END IF;
  RETURN EXISTS (
    SELECT 1 FROM public.expenses e
     WHERE e.id = p_expense_id
       AND NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT])
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
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE v_member JSONB; v_old JSONB; v_result JSONB := '[]'::jsonb; v_role TEXT; v_permissions JSONB;
BEGIN
  IF jsonb_typeof(COALESCE(NEW.members, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Trip members must be an array'; END IF;
  FOR v_member IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) LOOP
    v_old := NULL;
    IF TG_OP = 'UPDATE' THEN SELECT value INTO v_old FROM jsonb_array_elements(COALESCE(OLD.members, '[]'::jsonb)) WHERE value ->> 'id' = v_member ->> 'id' LIMIT 1; END IF;
    IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND current_setting('stellar_star.role_change', true) IS DISTINCT FROM 'on' THEN
      v_member := jsonb_set(v_member, '{role}', to_jsonb(COALESCE(v_old ->> 'role', CASE WHEN upper(btrim(COALESCE(v_old ->> 'walletAddress',''))) = upper(btrim(OLD.created_by_wallet)) THEN 'owner' ELSE 'contributor' END)));
      v_member := v_member - 'customPermissions' || CASE WHEN v_old ? 'customPermissions' THEN jsonb_build_object('customPermissions', v_old -> 'customPermissions') ELSE '{}'::jsonb END;
    ELSIF TG_OP = 'UPDATE' AND v_old IS NULL THEN
      v_member := v_member - 'customPermissions' || jsonb_build_object('role', 'contributor');
    END IF;
    v_role := COALESCE(v_member ->> 'role', CASE WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress',''))) = upper(btrim(NEW.created_by_wallet)) THEN 'owner' ELSE 'contributor' END);
    IF v_role NOT IN ('owner','organizer','contributor','viewer','custom') THEN RAISE EXCEPTION 'Invalid trip role'; END IF;
    v_member := jsonb_set(v_member, '{role}', to_jsonb(v_role)); v_permissions := COALESCE(v_member -> 'customPermissions', '[]'::jsonb);
    IF v_role = 'custom' AND (jsonb_typeof(v_permissions) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_permissions) p WHERE p NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage'))) THEN RAISE EXCEPTION 'Invalid custom trip permission'; END IF;
    IF v_role <> 'custom' THEN v_member := v_member - 'customPermissions'; END IF;
    v_result := v_result || jsonb_build_array(v_member);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result) member WHERE member ->> 'role' = 'owner' AND btrim(COALESCE(member ->> 'walletAddress','')) <> '') THEN RAISE EXCEPTION 'A trip must retain at least one owner; transfer ownership before demoting or removing the final owner'; END IF;
  NEW.members := v_result; RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_015_trips_normalize_roles ON public.trips;
CREATE TRIGGER trg_015_trips_normalize_roles BEFORE INSERT OR UPDATE OF members ON public.trips FOR EACH ROW EXECUTE FUNCTION public.normalize_trip_member_roles();

CREATE OR REPLACE FUNCTION public.set_trip_member_role(p_trip_id UUID, p_member_id TEXT, p_role TEXT, p_custom_permissions TEXT[] DEFAULT ARRAY[]::TEXT[])
RETURNS public.trips LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_trip public.trips; v_target JSONB; v_previous_role TEXT; v_previous_permissions TEXT[]; v_owners INT; v_members JSONB;
BEGIN
  IF p_role NOT IN ('owner','organizer','contributor','viewer','custom') THEN RAISE EXCEPTION 'INVALID_ROLE'; END IF;
  IF p_role = 'custom' AND EXISTS (SELECT 1 FROM unnest(COALESCE(p_custom_permissions, ARRAY[]::TEXT[])) p WHERE p IS NULL OR p NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage')) THEN RAISE EXCEPTION 'INVALID_CUSTOM_PERMISSION'; END IF;
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'TRIP_NOT_FOUND'; END IF;
  IF public.trip_member_role(p_trip_id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'ROLE_CHANGE_FORBIDDEN'; END IF;
  SELECT member INTO v_target FROM jsonb_array_elements(v_trip.members) member WHERE member ->> 'id' = p_member_id LIMIT 1; IF v_target IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
  IF p_role = 'owner' AND btrim(COALESCE(v_target ->> 'walletAddress','')) = '' THEN RAISE EXCEPTION 'OWNER_REQUIRES_WALLET'; END IF;
  v_previous_role := COALESCE(v_target ->> 'role','contributor'); SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_previous_permissions FROM jsonb_array_elements_text(COALESCE(v_target -> 'customPermissions','[]'::jsonb)) value;
  SELECT count(*) INTO v_owners FROM jsonb_array_elements(v_trip.members) member WHERE COALESCE(member ->> 'role','contributor') = 'owner' AND btrim(COALESCE(member ->> 'walletAddress','')) <> '';
  IF v_previous_role = 'owner' AND p_role <> 'owner' AND v_owners = 1 THEN RAISE EXCEPTION 'OWNERSHIP_TRANSFER_REQUIRED'; END IF;
  SELECT jsonb_agg(CASE WHEN member ->> 'id' = p_member_id THEN (member - 'customPermissions') || jsonb_build_object('role',p_role) || CASE WHEN p_role = 'custom' THEN jsonb_build_object('customPermissions',to_jsonb(COALESCE(p_custom_permissions,ARRAY[]::TEXT[]))) ELSE '{}'::jsonb END ELSE member END) INTO v_members FROM jsonb_array_elements(v_trip.members) member;
  PERFORM set_config('stellar_star.role_change','on',true); UPDATE public.trips SET members = v_members WHERE id = p_trip_id RETURNING * INTO v_trip;
  INSERT INTO public.trip_role_audit(trip_id,member_id,previous_role,next_role,previous_custom_permissions,next_custom_permissions,changed_by_wallet) VALUES(p_trip_id,p_member_id,v_previous_role,p_role,v_previous_permissions,CASE WHEN p_role = 'custom' THEN COALESCE(p_custom_permissions,ARRAY[]::TEXT[]) ELSE ARRAY[]::TEXT[] END,public.current_wallet());
  RETURN v_trip;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.add_expense_to_trip(p_trip_id UUID, p_expense_id UUID)
RETURNS TEXT[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_ids TEXT[];
BEGIN
  IF NOT public.trip_has_permission(p_trip_id,'expenses.manage') THEN RAISE EXCEPTION 'EXPENSE_LINK_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.expenses WHERE id=p_expense_id) THEN RAISE EXCEPTION 'EXPENSE_NOT_FOUND'; END IF;
  UPDATE public.trips SET expense_ids = ARRAY(SELECT DISTINCT unnest(expense_ids || ARRAY[p_expense_id::TEXT])) WHERE id=p_trip_id RETURNING expense_ids INTO v_ids; RETURN v_ids;
END;
$fn$;

ALTER TABLE public.trip_role_audit ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trip_role_audit_select_members ON public.trip_role_audit;
CREATE POLICY trip_role_audit_select_members ON public.trip_role_audit FOR SELECT TO authenticated USING (public.trip_has_permission(trip_id,'exports.view'));
DROP POLICY IF EXISTS trips_update_members ON public.trips;
DROP POLICY IF EXISTS trips_update_authorized ON public.trips;
CREATE POLICY trips_update_authorized ON public.trips FOR UPDATE TO authenticated USING (public.trip_has_permission(id,'trip.settings.manage')) WITH CHECK (public.trip_has_permission(id,'trip.settings.manage'));
DROP POLICY IF EXISTS expenses_update_members ON public.expenses;
DROP POLICY IF EXISTS expenses_update_authorized ON public.expenses;
CREATE POLICY expenses_update_authorized ON public.expenses FOR UPDATE TO authenticated USING (public.expense_has_permission(id,'expenses.manage')) WITH CHECK (public.expense_has_permission(id,'expenses.manage'));
DROP POLICY IF EXISTS expenses_delete_creator ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_authorized ON public.expenses;
CREATE POLICY expenses_delete_authorized ON public.expenses FOR DELETE TO authenticated USING (public.expense_has_permission(id,'expenses.manage'));
DROP POLICY IF EXISTS trip_invites_insert_members ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_insert_authorized ON public.trip_invites;
CREATE POLICY trip_invites_insert_authorized ON public.trip_invites FOR INSERT TO authenticated WITH CHECK (created_by_wallet = public.current_wallet() AND public.trip_has_permission(trip_id,'members.manage'));
DROP POLICY IF EXISTS trip_invites_update_creator ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_update_authorized ON public.trip_invites;
CREATE POLICY trip_invites_update_authorized ON public.trip_invites FOR UPDATE TO authenticated USING (public.trip_has_permission(trip_id,'members.manage')) WITH CHECK (public.trip_has_permission(trip_id,'members.manage'));
GRANT SELECT ON public.trip_role_audit TO authenticated;
GRANT EXECUTE ON FUNCTION public.trip_member_role(UUID,TEXT), public.trip_has_permission(UUID,TEXT), public.expense_has_permission(UUID,TEXT), public.set_trip_member_role(UUID,TEXT,TEXT,TEXT[]), public.add_expense_to_trip(UUID,UUID) TO authenticated;

-- Migration 0016 hardens the original role draft, including legacy invite
-- claims, atomic ownership transfer, and the optimistic expense-update RPC.
CREATE OR REPLACE FUNCTION public.normalize_trip_member_roles()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
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
      SELECT value INTO v_old FROM jsonb_array_elements(COALESCE(OLD.members, '[]'::jsonb))
       WHERE value ->> 'id' = v_member ->> 'id' LIMIT 1;
    END IF;

    IF TG_OP = 'UPDATE' AND v_old IS NOT NULL
       AND current_setting('stellar_star.role_change', true) IS DISTINCT FROM 'on' THEN
      v_member := jsonb_set(v_member, '{role}', to_jsonb(COALESCE(v_old ->> 'role',
        CASE WHEN upper(btrim(COALESCE(v_old ->> 'walletAddress', ''))) = upper(btrim(OLD.created_by_wallet))
          THEN 'owner' ELSE 'contributor' END)));
      v_member := (v_member - 'customPermissions') ||
        CASE WHEN v_old ? 'customPermissions'
          THEN jsonb_build_object('customPermissions', v_old -> 'customPermissions')
          ELSE '{}'::jsonb END;
    ELSIF TG_OP = 'UPDATE' AND v_old IS NULL THEN
      v_member := (v_member - 'customPermissions') || jsonb_build_object('role', 'contributor');
    ELSIF TG_OP = 'INSERT' THEN
      v_member := (v_member - 'customPermissions') || jsonb_build_object('role',
        CASE WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress', ''))) = upper(btrim(NEW.created_by_wallet))
          THEN 'owner' ELSE 'contributor' END);
    END IF;

    v_role := COALESCE(v_member ->> 'role',
      CASE WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress', ''))) = upper(btrim(NEW.created_by_wallet))
        THEN 'owner' ELSE 'contributor' END);
    IF v_role NOT IN ('owner', 'organizer', 'contributor', 'viewer', 'custom') THEN
      RAISE EXCEPTION 'Invalid trip role';
    END IF;
    v_member := jsonb_set(v_member, '{role}', to_jsonb(v_role));
    v_permissions := COALESCE(v_member -> 'customPermissions', '[]'::jsonb);
    IF v_role = 'custom' THEN
      IF jsonb_typeof(v_permissions) <> 'array' OR EXISTS (
        SELECT 1 FROM jsonb_array_elements_text(v_permissions) permission
         WHERE permission IS NULL OR permission NOT IN ('trip.settings.manage', 'members.manage', 'expenses.manage',
           'receipts.manage', 'exports.view', 'reminders.manage', 'settlement.proposals.manage')
      ) THEN RAISE EXCEPTION 'Invalid custom trip permission'; END IF;
    ELSE
      v_member := v_member - 'customPermissions';
    END IF;
    v_result := v_result || jsonb_build_array(v_member);
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result) member
    WHERE member ->> 'role' = 'owner' AND btrim(COALESCE(member ->> 'walletAddress', '')) <> '') THEN
    RAISE EXCEPTION 'A trip must retain at least one owner; transfer ownership before demoting or removing the final owner';
  END IF;
  NEW.members := v_result;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.guard_trip_update()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE
  v_internal_role_change BOOLEAN := current_setting('stellar_star.role_change', true) = 'on';
  v_self_join BOOLEAN := public.trip_member_role(OLD.id, public.current_wallet()) IS NULL
    AND public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) member
      WHERE upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(public.current_wallet())))
    AND (to_jsonb(NEW) - 'members' - 'member_wallets' - 'updated_at')
      IS NOT DISTINCT FROM (to_jsonb(OLD) - 'members' - 'member_wallets' - 'updated_at');
BEGIN
  IF NEW.members IS DISTINCT FROM OLD.members AND NOT v_internal_role_change AND NOT v_self_join
     AND NOT public.trip_has_permission(OLD.id, 'members.manage') THEN
    RAISE EXCEPTION 'TRIP_MEMBERS_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  IF NEW.expense_ids IS DISTINCT FROM OLD.expense_ids AND NOT v_internal_role_change
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
CREATE TRIGGER trg_014_trips_guard_authorization BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.guard_trip_update();
DROP TRIGGER IF EXISTS trg_015_trips_normalize_roles ON public.trips;
CREATE TRIGGER trg_015_trips_normalize_roles BEFORE INSERT OR UPDATE OF members ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.normalize_trip_member_roles();

CREATE OR REPLACE FUNCTION public.update_expense_versioned(
  p_id UUID, p_expected_version INT, p_title TEXT, p_description TEXT,
  p_total_amount TEXT, p_currency TEXT, p_split_mode TEXT,
  p_paid_by_member_id TEXT, p_members JSONB, p_shares JSONB, p_settled BOOLEAN
)
RETURNS SETOF public.expenses LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_current_version INT;
BEGIN
  IF NOT public.expense_has_permission(p_id, 'expenses.manage') THEN
    RAISE EXCEPTION 'EXPENSE_UPDATE_FORBIDDEN' USING ERRCODE = '42501';
  END IF;
  SELECT version INTO v_current_version FROM public.expenses WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found'; END IF;
  IF v_current_version <> p_expected_version THEN
    RAISE EXCEPTION 'Version conflict: expected %, got %', p_expected_version, v_current_version USING ERRCODE = '40001';
  END IF;
  RETURN QUERY UPDATE public.expenses
    SET title = COALESCE(p_title, title), description = COALESCE(p_description, description),
        split_mode = COALESCE(p_split_mode, split_mode), paid_by_member_id = COALESCE(p_paid_by_member_id, paid_by_member_id),
        members = COALESCE(p_members, members), shares = COALESCE(p_shares, shares),
        settled = COALESCE(p_settled, settled), version = version + 1
    WHERE id = p_id RETURNING *;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.transfer_trip_ownership(p_trip_id UUID, p_new_owner_member_id TEXT)
RETURNS public.trips LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_trip public.trips;
  v_actor JSONB;
  v_target JSONB;
  v_actor_id TEXT;
  v_members JSONB;
  v_actor_role TEXT;
  v_target_role TEXT;
  v_actor_permissions TEXT[];
  v_target_permissions TEXT[];
BEGIN
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'TRIP_NOT_FOUND'; END IF;
  IF public.trip_member_role(p_trip_id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION 'OWNERSHIP_TRANSFER_FORBIDDEN';
  END IF;
  SELECT member INTO v_actor FROM jsonb_array_elements(v_trip.members) member
    WHERE upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(public.current_wallet()))
      AND COALESCE(member ->> 'role', 'owner') = 'owner' LIMIT 1;
  SELECT member INTO v_target FROM jsonb_array_elements(v_trip.members) member
    WHERE member ->> 'id' = p_new_owner_member_id LIMIT 1;
  IF v_actor IS NULL OR v_target IS NULL OR btrim(COALESCE(v_target ->> 'walletAddress', '')) = '' THEN
    RAISE EXCEPTION 'MEMBER_NOT_FOUND';
  END IF;
  v_actor_id := v_actor ->> 'id';
  IF v_actor_id = p_new_owner_member_id THEN RAISE EXCEPTION 'ALREADY_OWNER'; END IF;
  v_actor_role := COALESCE(v_actor ->> 'role', 'owner');
  v_target_role := COALESCE(v_target ->> 'role',
    CASE WHEN upper(btrim(COALESCE(v_target ->> 'walletAddress', ''))) = upper(btrim(v_trip.created_by_wallet))
      THEN 'owner' ELSE 'contributor' END);
  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_actor_permissions
    FROM jsonb_array_elements_text(COALESCE(v_actor -> 'customPermissions', '[]'::jsonb)) value;
  SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_target_permissions
    FROM jsonb_array_elements_text(COALESCE(v_target -> 'customPermissions', '[]'::jsonb)) value;
  SELECT jsonb_agg(CASE
    WHEN member ->> 'id' = v_actor_id THEN (member - 'customPermissions') || jsonb_build_object('role', 'organizer')
    WHEN member ->> 'id' = p_new_owner_member_id THEN (member - 'customPermissions') || jsonb_build_object('role', 'owner')
    ELSE member END) INTO v_members FROM jsonb_array_elements(v_trip.members) member;
  PERFORM set_config('stellar_star.role_change', 'on', true);
  UPDATE public.trips SET members = v_members WHERE id = p_trip_id RETURNING * INTO v_trip;
  INSERT INTO public.trip_role_audit (
    trip_id, member_id, previous_role, next_role, previous_custom_permissions, next_custom_permissions, changed_by_wallet
  ) VALUES
    (p_trip_id, v_actor_id, v_actor_role, 'organizer', v_actor_permissions, ARRAY[]::TEXT[], public.current_wallet()),
    (p_trip_id, p_new_owner_member_id, v_target_role, 'owner', v_target_permissions, ARRAY[]::TEXT[], public.current_wallet());
  RETURN v_trip;
END;
$fn$;

CREATE TABLE IF NOT EXISTS public.expense_receipts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID REFERENCES public.expenses (id) ON DELETE SET NULL,
  storage_path TEXT NOT NULL UNIQUE,
  file_name TEXT CHECK (file_name IS NULL OR char_length(file_name) <= 120),
  content_type TEXT NOT NULL CHECK (content_type IN (
    'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'
  )),
  size_bytes INT NOT NULL CHECK (size_bytes > 0),
  checksum_sha256 TEXT NOT NULL CHECK (checksum_sha256 ~ '^[0-9a-f]{64}$'),
  caption TEXT CHECK (caption IS NULL OR char_length(caption) <= 200),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'quarantined', 'removed')),
  scan_result JSONB NOT NULL DEFAULT '{}'::jsonb,
  uploaded_by_wallet TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  retain_until TIMESTAMPTZ NOT NULL,
  removed_at TIMESTAMPTZ,
  removed_by_wallet TEXT,
  removal_reason TEXT CHECK (removal_reason IS NULL OR removal_reason IN ('user', 'retention', 'expense_deleted'))
);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_expense_created_at
  ON public.expense_receipts (expense_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_expense_receipts_retain_until
  ON public.expense_receipts (retain_until) WHERE status <> 'removed';
CREATE UNIQUE INDEX IF NOT EXISTS expense_receipts_live_checksum_key
  ON public.expense_receipts (expense_id, checksum_sha256) WHERE status <> 'removed';
ALTER TABLE public.expense_receipts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS expense_receipts_select_members ON public.expense_receipts;
CREATE POLICY expense_receipts_select_members ON public.expense_receipts FOR SELECT TO authenticated
  USING (public.expense_has_permission(expense_id, 'receipts.manage'));
GRANT SELECT ON public.expense_receipts TO authenticated;
DO $receipt_bucket$
BEGIN
  IF to_regclass('storage.buckets') IS NULL THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'storage' AND table_name = 'buckets' AND column_name = 'allowed_mime_types') THEN
    INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    VALUES ('expense-receipts', 'expense-receipts', FALSE, 4194304,
      ARRAY['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif', 'application/pdf'])
    ON CONFLICT (id) DO UPDATE SET public = FALSE, file_size_limit = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;
  ELSE
    INSERT INTO storage.buckets (id, name, public)
    VALUES ('expense-receipts', 'expense-receipts', FALSE)
    ON CONFLICT (id) DO UPDATE SET public = FALSE;
  END IF;
END
$receipt_bucket$;

CREATE TABLE IF NOT EXISTS public.payment_reminders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id TEXT NOT NULL,
  expense_id TEXT NOT NULL,
  member_id TEXT NOT NULL,
  recipient_wallet TEXT NOT NULL,
  sender_wallet TEXT NOT NULL,
  amount TEXT NOT NULL CHECK (amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  asset TEXT NOT NULL DEFAULT 'native',
  note TEXT CHECK (note IS NULL OR char_length(note) <= 280),
  trigger TEXT NOT NULL DEFAULT 'manual' CHECK (trigger IN ('manual', 'schedule')),
  schedule_id UUID,
  state TEXT NOT NULL DEFAULT 'delivered'
    CHECK (state IN ('delivered', 'read', 'dismissed', 'cancelled', 'muted')),
  channels TEXT[] NOT NULL DEFAULT ARRAY['in_app']::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  read_at TIMESTAMPTZ,
  CONSTRAINT payment_reminders_not_self CHECK (sender_wallet <> recipient_wallet)
);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_recipient_created_at
  ON public.payment_reminders (recipient_wallet, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_reminders_sender_created_at
  ON public.payment_reminders (sender_wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reminder_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reminder_id UUID REFERENCES public.payment_reminders(id) ON DELETE CASCADE,
  actor_wallet TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN (
    'sent', 'delivered', 'skipped', 'read', 'dismissed', 'cancelled',
    'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender',
    'opted_in', 'opted_out', 'unsubscribed', 'schedule_created', 'schedule_disabled'
  )),
  channel TEXT CHECK (channel IS NULL OR channel IN ('in_app', 'email', 'push')),
  detail TEXT CHECK (detail IS NULL OR char_length(detail) <= 200),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_reminder_events_reminder_created_at
  ON public.reminder_events (reminder_id, created_at);
CREATE INDEX IF NOT EXISTS idx_reminder_events_actor_created_at
  ON public.reminder_events (actor_wallet, created_at DESC);

CREATE TABLE IF NOT EXISTS public.reminder_preferences (
  wallet TEXT PRIMARY KEY,
  email_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  email_address TEXT CHECK (email_address IS NULL OR char_length(email_address) <= 254),
  push_opt_in BOOLEAN NOT NULL DEFAULT FALSE,
  push_endpoint TEXT CHECK (push_endpoint IS NULL OR char_length(push_endpoint) <= 1024),
  muted_trip_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  muted_sender_wallets TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.reminder_schedules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id TEXT NOT NULL,
  owner_wallet TEXT NOT NULL,
  interval_days INT NOT NULL CHECK (interval_days BETWEEN 1 AND 30),
  next_run_at TIMESTAMPTZ NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS reminder_schedules_one_active
  ON public.reminder_schedules (trip_id, owner_wallet) WHERE active;
CREATE INDEX IF NOT EXISTS idx_reminder_schedules_due
  ON public.reminder_schedules (next_run_at) WHERE active;

DROP TRIGGER IF EXISTS trg_01_payment_reminders_set_updated_at ON public.payment_reminders;
CREATE TRIGGER trg_01_payment_reminders_set_updated_at BEFORE UPDATE ON public.payment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_01_reminder_preferences_set_updated_at ON public.reminder_preferences;
CREATE TRIGGER trg_01_reminder_preferences_set_updated_at BEFORE UPDATE ON public.reminder_preferences
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
DROP TRIGGER IF EXISTS trg_01_reminder_schedules_set_updated_at ON public.reminder_schedules;
CREATE TRIGGER trg_01_reminder_schedules_set_updated_at BEFORE UPDATE ON public.reminder_schedules
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.payment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reminder_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS payment_reminders_select_party ON public.payment_reminders;
CREATE POLICY payment_reminders_select_party ON public.payment_reminders FOR SELECT TO authenticated
  USING (public.current_wallet() IN (sender_wallet, recipient_wallet));
DROP POLICY IF EXISTS payment_reminders_insert_sender ON public.payment_reminders;
CREATE POLICY payment_reminders_insert_sender ON public.payment_reminders FOR INSERT TO authenticated
  WITH CHECK (sender_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'));
DROP POLICY IF EXISTS payment_reminders_update_party ON public.payment_reminders;
CREATE POLICY payment_reminders_update_party ON public.payment_reminders FOR UPDATE TO authenticated
  USING (public.current_wallet() = recipient_wallet OR (
    public.current_wallet() = sender_wallet AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
  ))
  WITH CHECK (public.current_wallet() = recipient_wallet OR (
    public.current_wallet() = sender_wallet AND public.trip_has_permission(trip_id::UUID, 'reminders.manage')
  ));
DROP POLICY IF EXISTS reminder_events_insert_actor ON public.reminder_events;
CREATE POLICY reminder_events_insert_actor ON public.reminder_events FOR INSERT TO authenticated
  WITH CHECK (actor_wallet = public.current_wallet() AND (
    (reminder_id IS NULL AND kind IN (
      'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender',
      'opted_in', 'opted_out', 'unsubscribed', 'schedule_created', 'schedule_disabled'
    )) OR EXISTS (
      SELECT 1 FROM public.payment_reminders r WHERE r.id = reminder_id AND (
        (r.sender_wallet = public.current_wallet() AND public.trip_has_permission(r.trip_id::UUID, 'reminders.manage'))
        OR (r.recipient_wallet = public.current_wallet()
          AND kind IN ('read', 'dismissed', 'muted_trip', 'unmuted_trip', 'muted_sender', 'unmuted_sender'))
      )
    )
  ));
DROP POLICY IF EXISTS payment_reminders_update_party ON public.payment_reminders;
CREATE POLICY payment_reminders_update_party ON public.payment_reminders FOR UPDATE TO authenticated
  USING (public.current_wallet() IN (sender_wallet, recipient_wallet))
  WITH CHECK (public.current_wallet() IN (sender_wallet, recipient_wallet));
DROP POLICY IF EXISTS reminder_events_select_party ON public.reminder_events;
CREATE POLICY reminder_events_select_party ON public.reminder_events FOR SELECT TO authenticated
  USING (actor_wallet = public.current_wallet() OR EXISTS (
    SELECT 1 FROM public.payment_reminders r WHERE r.id = reminder_id
      AND public.current_wallet() IN (r.sender_wallet, r.recipient_wallet)
  ));
DROP POLICY IF EXISTS reminder_events_insert_actor ON public.reminder_events;
CREATE POLICY reminder_events_insert_actor ON public.reminder_events FOR INSERT TO authenticated
  WITH CHECK (actor_wallet = public.current_wallet());
DROP POLICY IF EXISTS reminder_preferences_own ON public.reminder_preferences;
CREATE POLICY reminder_preferences_own ON public.reminder_preferences FOR ALL TO authenticated
  USING (wallet = public.current_wallet()) WITH CHECK (wallet = public.current_wallet());
DROP POLICY IF EXISTS reminder_schedules_owner ON public.reminder_schedules;
CREATE POLICY reminder_schedules_owner ON public.reminder_schedules FOR ALL TO authenticated
  USING (owner_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'))
  WITH CHECK (owner_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'));
GRANT SELECT, INSERT, UPDATE ON public.payment_reminders TO authenticated;
GRANT SELECT, INSERT ON public.reminder_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reminder_preferences TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.reminder_schedules TO authenticated;

REVOKE ALL ON FUNCTION public.trip_member_role(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trip_has_permission(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.expense_has_permission(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.set_trip_member_role(UUID,TEXT,TEXT,TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transfer_trip_ownership(UUID,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.add_expense_to_trip(UUID,UUID) FROM PUBLIC;

DROP POLICY IF EXISTS trip_role_audit_select_members ON public.trip_role_audit;
DROP POLICY IF EXISTS trip_role_audit_select_members ON public.trip_role_audit;
CREATE POLICY trip_role_audit_select_members ON public.trip_role_audit FOR SELECT TO authenticated
  USING (public.trip_member_role(trip_id, public.current_wallet()) IS NOT NULL);
DROP POLICY IF EXISTS trips_update_member ON public.trips;
DROP POLICY IF EXISTS trips_update_members ON public.trips;
DROP POLICY IF EXISTS trips_update_authorized ON public.trips;
DROP POLICY IF EXISTS trips_update_authorized ON public.trips;
CREATE POLICY trips_update_authorized ON public.trips FOR UPDATE TO authenticated
  USING (public.trip_has_permission(id, 'trip.settings.manage') OR public.trip_has_permission(id, 'members.manage')
    OR public.trip_has_permission(id, 'expenses.manage'))
  WITH CHECK (public.trip_has_permission(id, 'trip.settings.manage') OR public.trip_has_permission(id, 'members.manage')
    OR public.trip_has_permission(id, 'expenses.manage'));
DROP POLICY IF EXISTS expenses_update_member ON public.expenses;
DROP POLICY IF EXISTS expenses_update_members ON public.expenses;
DROP POLICY IF EXISTS expenses_update_authorized ON public.expenses;
DROP POLICY IF EXISTS expenses_update_authorized ON public.expenses;
CREATE POLICY expenses_update_authorized ON public.expenses FOR UPDATE TO authenticated
  USING (public.expense_has_permission(id, 'expenses.manage'))
  WITH CHECK (public.expense_has_permission(id, 'expenses.manage'));
DROP POLICY IF EXISTS expenses_delete_owner ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_creator ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_authorized ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_authorized ON public.expenses;
CREATE POLICY expenses_delete_authorized ON public.expenses FOR DELETE TO authenticated
  USING (public.expense_has_permission(id, 'expenses.manage'));
DROP POLICY IF EXISTS trip_invites_insert_members ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_insert_authorized ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_insert_authorized ON public.trip_invites;
CREATE POLICY trip_invites_insert_authorized ON public.trip_invites FOR INSERT TO authenticated
  WITH CHECK (created_by_wallet = public.current_wallet() AND public.trip_has_permission(trip_id, 'members.manage'));
DROP POLICY IF EXISTS trip_invites_update_creator ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_update_authorized ON public.trip_invites;
DROP POLICY IF EXISTS trip_invites_update_authorized ON public.trip_invites;
CREATE POLICY trip_invites_update_authorized ON public.trip_invites FOR UPDATE TO authenticated
  USING (public.trip_has_permission(trip_id, 'members.manage'))
  WITH CHECK (public.trip_has_permission(trip_id, 'members.manage'));
DROP POLICY IF EXISTS expense_receipts_select_members ON public.expense_receipts;
CREATE POLICY expense_receipts_select_members ON public.expense_receipts FOR SELECT TO authenticated
  USING (public.expense_has_permission(expense_id, 'receipts.manage'));
DROP POLICY IF EXISTS payment_reminders_insert_sender ON public.payment_reminders;
CREATE POLICY payment_reminders_insert_sender ON public.payment_reminders FOR INSERT TO authenticated
  WITH CHECK (sender_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'));
DROP POLICY IF EXISTS reminder_schedules_owner ON public.reminder_schedules;
CREATE POLICY reminder_schedules_owner ON public.reminder_schedules FOR ALL TO authenticated
  USING (owner_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'))
  WITH CHECK (owner_wallet = public.current_wallet() AND public.trip_has_permission(trip_id::UUID, 'reminders.manage'));
DROP POLICY IF EXISTS settlement_proposals_insert_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_insert_member ON public.settlement_proposals FOR INSERT TO authenticated
  WITH CHECK (creator_wallet = public.current_wallet() AND status = 'open'
    AND public.trip_has_permission(trip_id::UUID, 'settlement.proposals.manage'));
DROP POLICY IF EXISTS settlement_proposals_update_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_update_member ON public.settlement_proposals FOR UPDATE TO authenticated
  USING (public.trip_has_permission(trip_id::UUID, 'settlement.proposals.manage'))
  WITH CHECK (status <> 'revoked' OR creator_wallet = public.current_wallet());
GRANT EXECUTE ON FUNCTION public.trip_member_role(UUID,TEXT), public.trip_has_permission(UUID,TEXT),
  public.expense_has_permission(UUID,TEXT), public.set_trip_member_role(UUID,TEXT,TEXT,TEXT[]),
  public.transfer_trip_ownership(UUID,TEXT), public.add_expense_to_trip(UUID,UUID) TO authenticated;

-- ============================================================================
-- Configurable trip roles and granular permissions (migration 0008)
-- ============================================================================
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
CREATE INDEX IF NOT EXISTS trip_role_audit_trip_created_at_idx ON public.trip_role_audit (trip_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.trip_member_role(p_trip_id UUID, p_wallet TEXT)
RETURNS TEXT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(member ->> 'role', CASE WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet)) THEN 'owner' ELSE 'contributor' END)
  FROM public.trips t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
  WHERE t.id = p_trip_id AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(COALESCE(p_wallet, ''))) LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.trip_has_permission(p_trip_id UUID, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_wallet TEXT := public.current_wallet(); v_role TEXT; v_permissions JSONB;
BEGIN
  IF v_wallet IS NULL OR p_permission NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage') THEN RETURN FALSE; END IF;
  SELECT COALESCE(member ->> 'role', CASE WHEN upper(btrim(member ->> 'walletAddress')) = upper(btrim(t.created_by_wallet)) THEN 'owner' ELSE 'contributor' END), COALESCE(member -> 'customPermissions', '[]'::jsonb)
    INTO v_role, v_permissions FROM public.trips t CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.members, '[]'::jsonb)) member
   WHERE t.id = p_trip_id AND upper(btrim(COALESCE(member ->> 'walletAddress', ''))) = upper(btrim(v_wallet)) LIMIT 1;
  IF v_role IN ('owner','organizer') THEN RETURN TRUE; END IF;
  IF v_role = 'contributor' THEN RETURN p_permission IN ('expenses.manage','receipts.manage','exports.view'); END IF;
  IF v_role = 'viewer' THEN RETURN p_permission = 'exports.view'; END IF;
  IF v_role = 'custom' THEN RETURN v_permissions ? p_permission; END IF;
  RETURN FALSE;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.expense_has_permission(p_expense_id UUID, p_permission TEXT)
RETURNS BOOLEAN LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_wallet TEXT := public.current_wallet();
BEGIN
  IF v_wallet IS NULL THEN RETURN FALSE; END IF;
  IF EXISTS (SELECT 1 FROM public.trips t WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT] AND public.trip_has_permission(t.id, p_permission)) THEN RETURN TRUE; END IF;
  RETURN EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = p_expense_id AND e.created_by_wallet = v_wallet AND NOT EXISTS (SELECT 1 FROM public.trips t WHERE t.expense_ids @> ARRAY[p_expense_id::TEXT]));
END;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_trip_member_roles()
RETURNS TRIGGER LANGUAGE plpgsql SET search_path = public AS $fn$
DECLARE v_member JSONB; v_old JSONB; v_result JSONB := '[]'::jsonb; v_role TEXT; v_permissions JSONB;
BEGIN
  IF jsonb_typeof(COALESCE(NEW.members, '[]'::jsonb)) <> 'array' THEN RAISE EXCEPTION 'Trip members must be an array'; END IF;
  FOR v_member IN SELECT value FROM jsonb_array_elements(COALESCE(NEW.members, '[]'::jsonb)) LOOP
    v_old := NULL;
    IF TG_OP = 'UPDATE' THEN SELECT value INTO v_old FROM jsonb_array_elements(COALESCE(OLD.members, '[]'::jsonb)) WHERE value ->> 'id' = v_member ->> 'id' LIMIT 1; END IF;
    IF TG_OP = 'UPDATE' AND v_old IS NOT NULL AND current_setting('stellar_star.role_change', true) IS DISTINCT FROM 'on' THEN
      v_member := jsonb_set(v_member, '{role}', to_jsonb(COALESCE(v_old ->> 'role', CASE WHEN upper(btrim(COALESCE(v_old ->> 'walletAddress',''))) = upper(btrim(OLD.created_by_wallet)) THEN 'owner' ELSE 'contributor' END)));
      v_member := v_member - 'customPermissions' || CASE WHEN v_old ? 'customPermissions' THEN jsonb_build_object('customPermissions', v_old -> 'customPermissions') ELSE '{}'::jsonb END;
    ELSIF TG_OP = 'UPDATE' AND v_old IS NULL THEN
      v_member := v_member - 'customPermissions' || jsonb_build_object('role', 'contributor');
    END IF;
    v_role := COALESCE(v_member ->> 'role', CASE WHEN upper(btrim(COALESCE(v_member ->> 'walletAddress',''))) = upper(btrim(NEW.created_by_wallet)) THEN 'owner' ELSE 'contributor' END);
    IF v_role NOT IN ('owner','organizer','contributor','viewer','custom') THEN RAISE EXCEPTION 'Invalid trip role'; END IF;
    v_member := jsonb_set(v_member, '{role}', to_jsonb(v_role)); v_permissions := COALESCE(v_member -> 'customPermissions', '[]'::jsonb);
    IF v_role = 'custom' AND (jsonb_typeof(v_permissions) <> 'array' OR EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_permissions) p WHERE p NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage'))) THEN RAISE EXCEPTION 'Invalid custom trip permission'; END IF;
    IF v_role <> 'custom' THEN v_member := v_member - 'customPermissions'; END IF;
    v_result := v_result || jsonb_build_array(v_member);
  END LOOP;
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_result) member WHERE member ->> 'role' = 'owner' AND btrim(COALESCE(member ->> 'walletAddress','')) <> '') THEN RAISE EXCEPTION 'A trip must retain at least one owner; transfer ownership before demoting or removing the final owner'; END IF;
  NEW.members := v_result; RETURN NEW;
END;
$fn$;
DROP TRIGGER IF EXISTS trg_015_trips_normalize_roles ON public.trips;
CREATE TRIGGER trg_015_trips_normalize_roles BEFORE INSERT OR UPDATE OF members ON public.trips FOR EACH ROW EXECUTE FUNCTION public.normalize_trip_member_roles();

CREATE OR REPLACE FUNCTION public.set_trip_member_role(p_trip_id UUID, p_member_id TEXT, p_role TEXT, p_custom_permissions TEXT[] DEFAULT ARRAY[]::TEXT[])
RETURNS public.trips LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_trip public.trips; v_target JSONB; v_previous_role TEXT; v_previous_permissions TEXT[]; v_owners INT; v_members JSONB;
BEGIN
  IF p_role NOT IN ('owner','organizer','contributor','viewer','custom') THEN RAISE EXCEPTION 'INVALID_ROLE'; END IF;
  IF p_role = 'custom' AND EXISTS (SELECT 1 FROM unnest(COALESCE(p_custom_permissions, ARRAY[]::TEXT[])) p WHERE p NOT IN ('trip.settings.manage','members.manage','expenses.manage','receipts.manage','exports.view','reminders.manage','settlement.proposals.manage')) THEN RAISE EXCEPTION 'INVALID_CUSTOM_PERMISSION'; END IF;
  SELECT * INTO v_trip FROM public.trips WHERE id = p_trip_id FOR UPDATE; IF NOT FOUND THEN RAISE EXCEPTION 'TRIP_NOT_FOUND'; END IF;
  IF public.trip_member_role(p_trip_id, public.current_wallet()) IS DISTINCT FROM 'owner' THEN RAISE EXCEPTION 'ROLE_CHANGE_FORBIDDEN'; END IF;
  SELECT member INTO v_target FROM jsonb_array_elements(v_trip.members) member WHERE member ->> 'id' = p_member_id LIMIT 1; IF v_target IS NULL THEN RAISE EXCEPTION 'MEMBER_NOT_FOUND'; END IF;
  IF p_role = 'owner' AND btrim(COALESCE(v_target ->> 'walletAddress','')) = '' THEN RAISE EXCEPTION 'OWNER_REQUIRES_WALLET'; END IF;
  v_previous_role := COALESCE(v_target ->> 'role','contributor'); SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[]) INTO v_previous_permissions FROM jsonb_array_elements_text(COALESCE(v_target -> 'customPermissions','[]'::jsonb)) value;
  SELECT count(*) INTO v_owners FROM jsonb_array_elements(v_trip.members) member WHERE COALESCE(member ->> 'role','contributor') = 'owner' AND btrim(COALESCE(member ->> 'walletAddress','')) <> '';
  IF v_previous_role = 'owner' AND p_role <> 'owner' AND v_owners = 1 THEN RAISE EXCEPTION 'LAST_OWNER'; END IF;
  SELECT jsonb_agg(CASE WHEN member ->> 'id' = p_member_id THEN (member - 'customPermissions') || jsonb_build_object('role',p_role) || CASE WHEN p_role = 'custom' THEN jsonb_build_object('customPermissions',to_jsonb(COALESCE(p_custom_permissions,ARRAY[]::TEXT[]))) ELSE '{}'::jsonb END ELSE member END) INTO v_members FROM jsonb_array_elements(v_trip.members) member;
  PERFORM set_config('stellar_star.role_change','on',true); UPDATE public.trips SET members = v_members WHERE id = p_trip_id RETURNING * INTO v_trip;
  INSERT INTO public.trip_role_audit(trip_id,member_id,previous_role,next_role,previous_custom_permissions,next_custom_permissions,changed_by_wallet) VALUES(p_trip_id,p_member_id,v_previous_role,p_role,v_previous_permissions,CASE WHEN p_role = 'custom' THEN COALESCE(p_custom_permissions,ARRAY[]::TEXT[]) ELSE ARRAY[]::TEXT[] END,public.current_wallet());
  RETURN v_trip;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.add_expense_to_trip(p_trip_id UUID, p_expense_id UUID)
RETURNS TEXT[] LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE v_ids TEXT[];
BEGIN
  IF NOT public.trip_has_permission(p_trip_id,'expenses.manage') THEN RAISE EXCEPTION 'EXPENSE_LINK_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.expenses WHERE id=p_expense_id) THEN RAISE EXCEPTION 'EXPENSE_NOT_FOUND'; END IF;
  UPDATE public.trips SET expense_ids = ARRAY(SELECT DISTINCT unnest(expense_ids || ARRAY[p_expense_id::TEXT])) WHERE id=p_trip_id RETURNING expense_ids INTO v_ids; RETURN v_ids;
END;
$fn$;

ALTER TABLE public.trip_role_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY trip_role_audit_select_members ON public.trip_role_audit FOR SELECT TO authenticated USING (public.trip_has_permission(trip_id,'exports.view'));
DROP POLICY IF EXISTS trips_update_members ON public.trips;
CREATE POLICY trips_update_authorized ON public.trips FOR UPDATE TO authenticated USING (public.trip_has_permission(id,'trip.settings.manage')) WITH CHECK (public.trip_has_permission(id,'trip.settings.manage'));
DROP POLICY IF EXISTS expenses_update_members ON public.expenses;
CREATE POLICY expenses_update_authorized ON public.expenses FOR UPDATE TO authenticated USING (public.expense_has_permission(id,'expenses.manage')) WITH CHECK (public.expense_has_permission(id,'expenses.manage'));
DROP POLICY IF EXISTS expenses_delete_creator ON public.expenses;
CREATE POLICY expenses_delete_authorized ON public.expenses FOR DELETE TO authenticated USING (public.expense_has_permission(id,'expenses.manage'));
DROP POLICY IF EXISTS trip_invites_insert_members ON public.trip_invites;
CREATE POLICY trip_invites_insert_authorized ON public.trip_invites FOR INSERT TO authenticated WITH CHECK (created_by_wallet = public.current_wallet() AND public.trip_has_permission(trip_id,'members.manage'));
DROP POLICY IF EXISTS trip_invites_update_creator ON public.trip_invites;
CREATE POLICY trip_invites_update_authorized ON public.trip_invites FOR UPDATE TO authenticated USING (public.trip_has_permission(trip_id,'members.manage')) WITH CHECK (public.trip_has_permission(trip_id,'members.manage'));
GRANT SELECT ON public.trip_role_audit TO authenticated;
GRANT EXECUTE ON FUNCTION public.trip_member_role(UUID,TEXT), public.trip_has_permission(UUID,TEXT), public.expense_has_permission(UUID,TEXT), public.set_trip_member_role(UUID,TEXT,TEXT,TEXT[]), public.add_expense_to_trip(UUID,UUID) TO authenticated;


-- ============================================================================
-- EXPENSE CORRECTIONS, VOIDS & AUDIT TRAIL (#316)
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.expense_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('voided', 'correction_created', 'reversal_created', 'adjustment_created')),
  actor_wallet TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_audit_events_expense_id
  ON public.expense_audit_events (expense_id, created_at DESC);

CREATE OR REPLACE FUNCTION public.prevent_destructive_expense_operations()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  v_is_settled BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_is_settled := OLD.settled OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.shares) s
      WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
        OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
    );
    IF v_is_settled THEN
      RAISE EXCEPTION 'A settled expense cannot be deleted. Use a linked correction or offset to preserve financial history.' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.expenses WHERE correction_of_expense_id = OLD.id) THEN
      RAISE EXCEPTION 'An expense with linked corrections cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD.voided = TRUE THEN
      IF NEW.title IS DISTINCT FROM OLD.title
        OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.shares IS DISTINCT FROM OLD.shares
        OR NEW.settled IS DISTINCT FROM OLD.settled THEN
        RAISE EXCEPTION 'A voided expense is immutable.' USING ERRCODE = '42501';
      END IF;
    END IF;

    IF NEW.voided = TRUE AND OLD.voided = FALSE THEN
      v_is_settled := OLD.settled OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.shares) s
        WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
          OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
      );
      IF v_is_settled THEN
        RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_prevent_destructive_expense_ops ON public.expenses;
CREATE TRIGGER trg_prevent_destructive_expense_ops
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_destructive_expense_operations();

CREATE OR REPLACE FUNCTION public.record_expense_correction_audit_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.voided = TRUE AND OLD.voided = FALSE THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (NEW.id, 'voided', NEW.voided_by_wallet, NEW.void_reason, jsonb_build_object('total_amount', NEW.total_amount));
  ELSIF TG_OP = 'INSERT' AND NEW.correction_of_expense_id IS NOT NULL THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (
      NEW.id,
      CASE WHEN NEW.correction_type = 'reversal' THEN 'reversal_created' ELSE 'adjustment_created' END,
      NEW.created_by_wallet,
      NEW.correction_reason,
      jsonb_build_object('correction_of_expense_id', NEW.correction_of_expense_id, 'correction_type', NEW.correction_type)
    );
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_expense_correction_audit ON public.expenses;
CREATE TRIGGER trg_expense_correction_audit
  AFTER INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.record_expense_correction_audit_event();

CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS public.expenses LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE
  v_expense public.expenses%ROWTYPE;
  v_caller TEXT;
  v_trimmed_reason TEXT;
  v_is_settled BOOLEAN;
  v_is_authorized BOOLEAN;
BEGIN
  v_trimmed_reason := btrim(COALESCE(p_reason, ''));
  IF char_length(v_trimmed_reason) < 1 OR char_length(v_trimmed_reason) > 1000 THEN
    RAISE EXCEPTION 'A void reason between 1 and 1000 characters is required.' USING ERRCODE = '22023';
  END IF;

  v_caller := public.current_wallet();
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_expense FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_expense.voided THEN
    RAISE EXCEPTION 'Expense is already voided.' USING ERRCODE = '42501';
  END IF;

  v_is_authorized := (
    upper(v_expense.created_by_wallet) = upper(v_caller)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_expense.members) m
      WHERE m->>'id' = v_expense.paid_by_member_id AND upper(m->>'walletAddress') = upper(v_caller)
    )
    OR public.expense_has_permission(p_expense_id, 'expenses.manage')
  );
  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'You are not authorized to void this expense.' USING ERRCODE = '42501';
  END IF;

  v_is_settled := v_expense.settled OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_expense.shares) s
    WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
      OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
  );
  IF v_is_settled THEN
    RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.expenses
  SET voided = TRUE,
      voided_at = NOW(),
      voided_by_wallet = v_caller,
      void_reason = v_trimmed_reason,
      updated_at = NOW()
  WHERE id = p_expense_id
  RETURNING * INTO v_expense;

  RETURN v_expense;
END;
$fn$;

ALTER TABLE public.expense_audit_events ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON public.expense_audit_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES
  ('0001', '0001_baseline', 'baseline_initial_checksum'),
  ('0002', '0002_explicit_trigger_pipeline', 'trigger_pipeline_checksum'),
  ('0003', '0003_trip_invitations_capabilities', 'trip_invites_capability_checksum'),
  ('0004', '0004_settlement_intents', 'settlement_intents_v1'),
  ('0005', '0005_verify_trip_invite_rpc', 'verify_trip_invite_v1'),
  ('0006', '0006_settlement_request_ids', 'settlement_request_ids_v1'),
  ('0007', '0007_composite_query_indexes', 'composite_query_indexes_v1'),
  ('0008', '0008_trip_roles_and_permissions', 'trip_roles_permissions_v1')
ON CONFLICT (version) DO NOTHING;

-- 0019: Shared household coordination research prototype. Keep in sync with
-- migrations/0019_shared_household_coordination.sql.
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
RETURNS TRIGGER LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $fn$
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
  p_chore_id UUID, p_due_on DATE, p_supply_expense_id UUID DEFAULT NULL
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $fn$
DECLARE
  v_chore public.household_chores%ROWTYPE;
  v_trip public.trips%ROWTYPE;
  v_wallet TEXT := public.current_wallet();
  v_assignee TEXT;
  v_rotation_index INTEGER;
  v_offset INTEGER;
  v_completion_id UUID;
BEGIN
  IF v_wallet IS NULL THEN RAISE EXCEPTION 'HOUSEHOLD_AUTH_REQUIRED' USING ERRCODE = '42501'; END IF;
  SELECT * INTO v_chore FROM public.household_chores
  WHERE id = p_chore_id AND active FOR UPDATE;
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
    SELECT id INTO v_completion_id FROM public.household_chore_completions
    WHERE chore_id = v_chore.id AND due_on = p_due_on;
    RETURN v_completion_id;
  END IF;
  IF p_due_on IS DISTINCT FROM v_chore.next_due_on THEN RAISE EXCEPTION 'HOUSEHOLD_CHORE_NOT_DUE'; END IF;
  IF EXISTS (
    SELECT 1 FROM public.household_chore_preferences
    WHERE trip_id = v_chore.trip_id AND upper(wallet_address) = upper(v_wallet) AND opted_out
  ) THEN RAISE EXCEPTION 'HOUSEHOLD_MEMBER_OPTED_OUT' USING ERRCODE = '42501'; END IF;
  IF p_supply_expense_id IS NOT NULL AND NOT (
    v_trip.expense_ids @> ARRAY[p_supply_expense_id::TEXT]
    AND EXISTS (SELECT 1 FROM public.expenses WHERE id = p_supply_expense_id)
  ) THEN RAISE EXCEPTION 'HOUSEHOLD_EXPENSE_NOT_IN_TRIP'; END IF;

  FOR v_offset IN 0..cardinality(v_chore.rotation_wallets) - 1 LOOP
    v_rotation_index := (v_chore.rotation_cursor + v_offset) % cardinality(v_chore.rotation_wallets);
    v_assignee := v_chore.rotation_wallets[v_rotation_index + 1];
    IF EXISTS (
      SELECT 1 FROM unnest(v_trip.member_wallets) member_wallet
      WHERE upper(member_wallet) = upper(v_assignee)
    ) AND NOT EXISTS (
      SELECT 1 FROM public.household_chore_preferences preference
      WHERE preference.trip_id = v_chore.trip_id
        AND upper(preference.wallet_address) = upper(v_assignee)
        AND preference.opted_out
    ) THEN EXIT; END IF;
    v_assignee := NULL;
  END LOOP;
  IF v_assignee IS NULL THEN RAISE EXCEPTION 'HOUSEHOLD_NO_ELIGIBLE_ASSIGNEE'; END IF;
  IF upper(v_assignee) <> upper(v_wallet) THEN
    RAISE EXCEPTION 'HOUSEHOLD_CHORE_ASSIGNED_TO_ANOTHER_MEMBER' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.household_chore_completions (
    chore_id, trip_id, completed_by_wallet, due_on, supply_expense_id
  ) VALUES (v_chore.id, v_chore.trip_id, v_wallet, p_due_on, p_supply_expense_id)
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
    SELECT id INTO v_completion_id FROM public.household_chore_completions
    WHERE chore_id = v_chore.id AND due_on = p_due_on;
  END IF;
  RETURN v_completion_id;
END;
$fn$;

ALTER TABLE public.household_chores ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_chore_completions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_chore_preferences ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS household_chores_select_members ON public.household_chores;
CREATE POLICY household_chores_select_members ON public.household_chores FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chores.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));
DROP POLICY IF EXISTS household_chores_insert_members ON public.household_chores;
CREATE POLICY household_chores_insert_members ON public.household_chores FOR INSERT TO authenticated
WITH CHECK (
  created_by_wallet = public.current_wallet()
  AND EXISTS (
    SELECT 1 FROM public.trips trip WHERE trip.id = household_chores.trip_id
      AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
  )
  AND NOT EXISTS (
    SELECT 1 FROM unnest(household_chores.rotation_wallets) rotation_wallet
    WHERE NOT EXISTS (
      SELECT 1 FROM public.trips trip WHERE trip.id = household_chores.trip_id
        AND trip.member_wallets @> ARRAY[rotation_wallet]
    )
  )
);
DROP POLICY IF EXISTS household_chores_update_creators ON public.household_chores;
CREATE POLICY household_chores_update_creators ON public.household_chores FOR UPDATE TO authenticated
USING (created_by_wallet = public.current_wallet() AND EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chores.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
))
WITH CHECK (created_by_wallet = public.current_wallet() AND EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chores.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));
DROP POLICY IF EXISTS household_chores_delete_creators ON public.household_chores;

DROP POLICY IF EXISTS household_chore_completions_select_members ON public.household_chore_completions;
CREATE POLICY household_chore_completions_select_members ON public.household_chore_completions FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chore_completions.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));
DROP POLICY IF EXISTS household_chore_preferences_select_members ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_select_members ON public.household_chore_preferences FOR SELECT TO authenticated
USING (EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chore_preferences.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));
DROP POLICY IF EXISTS household_chore_preferences_insert_self ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_insert_self ON public.household_chore_preferences FOR INSERT TO authenticated
WITH CHECK (upper(wallet_address) = upper(public.current_wallet()) AND EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chore_preferences.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));
DROP POLICY IF EXISTS household_chore_preferences_update_self ON public.household_chore_preferences;
CREATE POLICY household_chore_preferences_update_self ON public.household_chore_preferences FOR UPDATE TO authenticated
USING (upper(wallet_address) = upper(public.current_wallet()) AND EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chore_preferences.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
))
WITH CHECK (upper(wallet_address) = upper(public.current_wallet()) AND EXISTS (
  SELECT 1 FROM public.trips trip WHERE trip.id = household_chore_preferences.trip_id
    AND trip.household_coordination_enabled AND trip.member_wallets @> ARRAY[public.current_wallet()]
));

GRANT SELECT, INSERT ON public.household_chores TO authenticated;
GRANT UPDATE (active) ON public.household_chores TO authenticated;
GRANT SELECT ON public.household_chore_completions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.household_chore_preferences TO authenticated;
REVOKE ALL ON FUNCTION public.complete_household_chore(UUID, DATE, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.complete_household_chore(UUID, DATE, UUID) TO authenticated;

DO $publication$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'household_chores') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chores;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'household_chore_completions') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chore_completions;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'household_chore_preferences') THEN
      ALTER PUBLICATION supabase_realtime ADD TABLE public.household_chore_preferences;
    END IF;
  END IF;
END;
$publication$;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_shared_household_coordination', 'household_coordination_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0008_expense_categories_tags_search.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0008: Expense categories, tags & filterable history
-- (issue #317)
-- ============================================================================
-- Lightweight organization for long trips. Nothing here changes how much
-- anyone owes: category and tags are labels, and settlement_asset only makes
-- the asset an expense already settles in queryable (NULL = native XLM, which
-- is what every existing row settles in).
--
-- Search and filtering run server-side in public.search_expenses(), a
-- SECURITY INVOKER function, so the caller's existing RLS policies decide
-- visibility exactly as they do for a plain SELECT.

-- ─── Columns ────────────────────────────────────────────────────────────────

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS settlement_asset TEXT,
  ADD COLUMN IF NOT EXISTS category TEXT,
  ADD COLUMN IF NOT EXISTS tags TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Keep in step with EXPENSE_CATEGORIES in lib/expense/categories.ts.
DO $constraints$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_category_check') THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_category_check CHECK (
        category IS NULL OR category IN (
          'food', 'groceries', 'lodging', 'transport', 'activities', 'shopping',
          'utilities', 'rent', 'subscriptions', 'health', 'other'
        )
      );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'expenses_tags_limit_check') THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_tags_limit_check CHECK (cardinality(tags) <= 10);
  END IF;
END
$constraints$;

-- ─── Tag normalization ──────────────────────────────────────────────────────
-- Mirrors normalizeTag() in lib/expense/tags.ts: lowercase, strip a leading
-- '#', collapse non-alphanumeric runs to '-', trim '-', cap at 32 characters,
-- de-duplicate keeping first-seen order. Enforced here so a client that skips
-- the TypeScript helper still cannot store "Beach" and "beach" as two tags.
CREATE OR REPLACE FUNCTION public.normalize_expense_tags(p_tags TEXT[])
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT COALESCE(array_agg(tag ORDER BY first_pos), ARRAY[]::TEXT[])
  FROM (
    SELECT tag, MIN(pos) AS first_pos
    FROM (
      SELECT
        btrim(left(btrim(regexp_replace(
          regexp_replace(lower(btrim(raw)), '^#+', ''),
          '[^[:alnum:]]+', '-', 'g'
        ), '-'), 32), '-') AS tag,
        pos
      FROM unnest(COALESCE(p_tags, ARRAY[]::TEXT[])) WITH ORDINALITY AS t(raw, pos)
    ) cleaned
    WHERE tag <> ''
    GROUP BY tag
  ) deduped;
$fn$;

CREATE OR REPLACE FUNCTION public.normalize_expense_labels()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.tags := public.normalize_expense_tags(NEW.tags);
  NEW.category := NULLIF(lower(btrim(NEW.category)), '');
  RETURN NEW;
END;
$fn$;

-- Runs after the 01–04 integrity pipeline (triggers fire alphabetically).
DROP TRIGGER IF EXISTS trg_05_expenses_normalize_labels ON public.expenses;
CREATE TRIGGER trg_05_expenses_normalize_labels
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.normalize_expense_labels();

-- ─── Freeze the settlement asset ────────────────────────────────────────────
-- The asset is part of the debt, exactly like the amount: a member relabelling
-- an expense must not be able to change what it settles in. Same function as
-- migration 0005, plus settlement_asset.
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
    || jsonb_build_object('created_by_wallet', old_json -> 'created_by_wallet')
    || jsonb_build_object('total_amount', old_json -> 'total_amount')
    || jsonb_build_object('currency', old_json -> 'currency')
    || jsonb_build_object('exchange_rate', old_json -> 'exchange_rate')
    || jsonb_build_object('exchange_rate_timestamp', old_json -> 'exchange_rate_timestamp')
    || jsonb_build_object('settlement_asset', old_json -> 'settlement_asset');

  RETURN jsonb_populate_record(NEW, new_json);
END;
$fn$;

-- ─── Search ─────────────────────────────────────────────────────────────────
-- Everything free-text search looks at, lowercased. Mirrors
-- expenseSearchDocument() in lib/expense/historyFilters.ts. Computed on read
-- rather than stored, so existing rows need no backfill (a backfill UPDATE
-- would re-run the share validation and bump updated_at on every expense).
CREATE OR REPLACE FUNCTION public.expense_search_document(p_expense public.expenses)
RETURNS TEXT
LANGUAGE sql
STABLE
AS $fn$
  SELECT lower(concat_ws(' ',
    p_expense.title,
    p_expense.description,
    p_expense.category,
    array_to_string(p_expense.tags, ' '),
    (SELECT string_agg(concat_ws(' ', m ->> 'name', m ->> 'walletAddress'), ' ')
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_expense.members) = 'array' THEN p_expense.members ELSE '[]'::jsonb END
       ) AS m),
    (SELECT string_agg(s ->> 'txHash', ' ')
       FROM jsonb_array_elements(
         CASE WHEN jsonb_typeof(p_expense.shares) = 'array' THEN p_expense.shares ELSE '[]'::jsonb END
       ) AS s
      WHERE s ? 'txHash')
  ));
$fn$;

-- Filtered, searched, keyset-paginated history. Every filter is optional (NULL
-- = not applied). Semantics match matchesExpenseHistoryFilters() in
-- lib/expense/historyFilters.ts:
--   p_trip_id   only expenses linked from that trip's expense_ids
--   p_terms     lowercased terms; ALL must appear in the search document
--   p_category  a category, or 'uncategorized' for NULL
--   p_tags      the expense must carry ALL of them
--   p_payer     paid_by_member_id, or the payer member's wallet address
--   p_status    'open' (not settled) | 'unpaid' | 'partial' | 'settled'
--   p_asset     canonical asset key; 'native' also matches NULL
--   p_from/p_to half-open [from, to) instant range on created_at
--   p_cursor_*  keyset position from the previous page (created_at, id)
CREATE OR REPLACE FUNCTION public.search_expenses(
  p_trip_id           UUID        DEFAULT NULL,
  p_terms             TEXT[]      DEFAULT NULL,
  p_category          TEXT        DEFAULT NULL,
  p_tags              TEXT[]      DEFAULT NULL,
  p_payer             TEXT        DEFAULT NULL,
  p_status            TEXT        DEFAULT NULL,
  p_asset             TEXT        DEFAULT NULL,
  p_from              TIMESTAMPTZ DEFAULT NULL,
  p_to                TIMESTAMPTZ DEFAULT NULL,
  p_cursor_created_at TIMESTAMPTZ DEFAULT NULL,
  p_cursor_id         UUID        DEFAULT NULL,
  p_limit             INT         DEFAULT 21
)
RETURNS SETOF public.expenses
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $fn$
  SELECT e.*
  FROM public.expenses e
  WHERE (p_trip_id IS NULL OR e.id::text IN (
          SELECT unnest(t.expense_ids) FROM public.trips t WHERE t.id = p_trip_id))
    AND (p_category IS NULL
         OR (p_category = 'uncategorized' AND e.category IS NULL)
         OR e.category = p_category)
    AND (p_tags IS NULL OR cardinality(p_tags) = 0 OR e.tags @> p_tags)
    AND (p_payer IS NULL
         OR e.paid_by_member_id = p_payer
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE WHEN jsonb_typeof(e.members) = 'array' THEN e.members ELSE '[]'::jsonb END
           ) AS m
           WHERE m ->> 'id' = e.paid_by_member_id
             AND upper(m ->> 'walletAddress') = upper(p_payer)))
    AND (p_status IS NULL
         OR (p_status = 'settled' AND e.settled)
         OR (p_status = 'open' AND NOT e.settled)
         OR (p_status IN ('unpaid', 'partial') AND NOT e.settled AND (
               EXISTS (
                 SELECT 1
                 FROM jsonb_array_elements(
                   CASE WHEN jsonb_typeof(e.shares) = 'array' THEN e.shares ELSE '[]'::jsonb END
                 ) AS s
                 WHERE (s ->> 'paid')::boolean IS TRUE)
             ) = (p_status = 'partial')))
    AND (p_asset IS NULL
         OR COALESCE(NULLIF(e.settlement_asset, ''), 'native') = p_asset)
    AND (p_from IS NULL OR e.created_at >= p_from)
    AND (p_to IS NULL OR e.created_at < p_to)
    AND (p_cursor_created_at IS NULL
         OR e.created_at < p_cursor_created_at
         OR (p_cursor_id IS NOT NULL AND e.created_at = p_cursor_created_at AND e.id < p_cursor_id))
    AND (p_terms IS NULL OR NOT EXISTS (
          SELECT 1 FROM unnest(p_terms) AS term
          WHERE strpos(public.expense_search_document(e), lower(term)) = 0))
  ORDER BY e.created_at DESC, e.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 21), 1), 101);
$fn$;

GRANT EXECUTE ON FUNCTION public.search_expenses(
  UUID, TEXT[], TEXT, TEXT[], TEXT, TEXT, TEXT, TIMESTAMPTZ, TIMESTAMPTZ, TIMESTAMPTZ, UUID, INT
) TO authenticated;

-- ─── Indexes ────────────────────────────────────────────────────────────────

-- Keyset pagination: ORDER BY created_at DESC, id DESC with a (created_at, id) bound.
CREATE INDEX IF NOT EXISTS idx_expenses_created_at_id
  ON public.expenses (created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_expenses_category_created_at
  ON public.expenses (category, created_at DESC);

-- Containment (tags @> ARRAY[...]) is what the tag filter uses.
CREATE INDEX IF NOT EXISTS idx_expenses_tags
  ON public.expenses USING GIN (tags);

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0008', '0008_expense_categories_tags_search', 'expense_categories_tags_search_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0008_trip_templates.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0008: Trip templates & duplicate-from-history (#321)
-- ============================================================================
-- Repeated groups (flatmates, teams, annual trips) can save a trip's structure
-- as a template, or start a new trip from a template or a past trip.
--
-- Guarantees enforced here rather than trusted from the client:
--   1. A copy never carries history. create_trip_from_copy writes
--      expense_ids = '{}' and settled = FALSE whatever the payload says.
--   2. Copies are idempotent. The caller supplies an idempotency key; a retry
--      with the same key returns the row the first call created.
--   3. Copies are audited. Every successful copy appends one immutable row to
--      trip_copy_events in the same transaction as the write it describes.
--   4. A caller can only copy what RLS already lets them read.
-- See docs/DESIGN_TRIP_TEMPLATES.md.

-- ── Trip structure columns ──────────────────────────────────────────────────
ALTER TABLE public.trips
  ADD COLUMN IF NOT EXISTS starts_on           DATE,
  ADD COLUMN IF NOT EXISTS ends_on             DATE,
  ADD COLUMN IF NOT EXISTS recurring_rules     JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS permissions         JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS source_template_id  TEXT,
  ADD COLUMN IF NOT EXISTS copied_from_trip_id TEXT;

-- ── Templates ───────────────────────────────────────────────────────────────
-- Private to the wallet that saved them. No balances, shares or payments: the
-- columns that would hold them do not exist.
CREATE TABLE IF NOT EXISTS public.trip_templates (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet     TEXT        NOT NULL,
  name             TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  description      TEXT,
  members          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  recurring_rules  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  permissions      JSONB       NOT NULL DEFAULT '{}'::jsonb,
  duration_days    INT         CHECK (duration_days IS NULL OR duration_days > 0),
  source_trip_id   TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trip_templates_owner_created_at
  ON public.trip_templates (owner_wallet, created_at DESC);

DROP TRIGGER IF EXISTS trip_templates_set_updated_at ON public.trip_templates;
CREATE TRIGGER trip_templates_set_updated_at
  BEFORE UPDATE ON public.trip_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.trip_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_templates_select_owner ON public.trip_templates;
CREATE POLICY trip_templates_select_owner ON public.trip_templates
  FOR SELECT USING (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_insert_owner ON public.trip_templates;
CREATE POLICY trip_templates_insert_owner ON public.trip_templates
  FOR INSERT WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_update_owner ON public.trip_templates;
CREATE POLICY trip_templates_update_owner ON public.trip_templates
  FOR UPDATE USING      (owner_wallet = public.current_wallet())
             WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_templates_delete_owner ON public.trip_templates;
CREATE POLICY trip_templates_delete_owner ON public.trip_templates
  FOR DELETE USING (owner_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_templates TO authenticated;

-- ── Copy audit log ──────────────────────────────────────────────────────────
-- Append-only: there is no UPDATE or DELETE policy, so under RLS a row can be
-- written once (by the function below, as the caller) and never rewritten.
CREATE TABLE IF NOT EXISTS public.trip_copy_events (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key  TEXT        NOT NULL,
  operation        TEXT        NOT NULL
                   CHECK (operation IN ('trip_to_template', 'template_to_trip', 'trip_to_trip')),
  actor_wallet     TEXT        NOT NULL,
  source_kind      TEXT        NOT NULL CHECK (source_kind IN ('template', 'trip')),
  source_id        TEXT        NOT NULL,
  target_kind      TEXT        NOT NULL CHECK (target_kind IN ('template', 'trip')),
  target_id        TEXT        NOT NULL,
  -- Counts of what was copied, for the audit trail. Never balances or amounts.
  summary          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT trip_copy_events_idempotency_key_unique UNIQUE (idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_trip_copy_events_actor_created_at
  ON public.trip_copy_events (actor_wallet, created_at DESC);

ALTER TABLE public.trip_copy_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_copy_events_select_actor ON public.trip_copy_events;
CREATE POLICY trip_copy_events_select_actor ON public.trip_copy_events
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS trip_copy_events_insert_actor ON public.trip_copy_events;
CREATE POLICY trip_copy_events_insert_actor ON public.trip_copy_events
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.trip_copy_events TO authenticated;

-- ── create_trip_from_copy ───────────────────────────────────────────────────
-- SECURITY INVOKER on purpose: every read and write below runs under the
-- caller's RLS, so a source the caller cannot see is reported as not found.
CREATE OR REPLACE FUNCTION public.create_trip_from_copy(
  p_idempotency_key TEXT,
  p_source_kind     TEXT,
  p_source_id       TEXT,
  p_trip            JSONB
)
RETURNS SETOF public.trips
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_wallet   TEXT := public.current_wallet();
  v_event    public.trip_copy_events%ROWTYPE;
  v_trip_id  UUID;
  v_name     TEXT := btrim(COALESCE(p_trip ->> 'name', ''));
  v_members  JSONB := COALESCE(p_trip -> 'members', '[]'::jsonb);
  v_rules    JSONB := COALESCE(p_trip -> 'recurring_rules', '[]'::jsonb);
  v_starts   DATE := NULLIF(p_trip ->> 'starts_on', '')::DATE;
  v_ends     DATE := NULLIF(p_trip ->> 'ends_on', '')::DATE;
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'COPY_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
    RAISE EXCEPTION 'COPY_INVALID_KEY';
  END IF;
  IF p_source_kind NOT IN ('template', 'trip') THEN
    RAISE EXCEPTION 'COPY_INVALID_SOURCE';
  END IF;

  -- Replay: the same key always resolves to the trip it first created.
  SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trips WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: name is required';
  END IF;
  IF jsonb_typeof(v_members) <> 'array' OR jsonb_array_length(v_members) < 2 THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: at least two members are required';
  END IF;
  IF jsonb_typeof(v_rules) <> 'array' THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: recurring_rules must be an array';
  END IF;
  IF v_starts IS NOT NULL AND v_ends IS NOT NULL AND v_ends < v_starts THEN
    RAISE EXCEPTION 'COPY_INVALID_TRIP: end date precedes start date';
  END IF;

  IF p_source_kind = 'template' THEN
    PERFORM 1 FROM public.trip_templates WHERE id::TEXT = p_source_id;
  ELSE
    PERFORM 1 FROM public.trips WHERE id::TEXT = p_source_id;
  END IF;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COPY_SOURCE_NOT_FOUND';
  END IF;

  v_trip_id := COALESCE(NULLIF(p_trip ->> 'id', '')::UUID, gen_random_uuid());

  -- Claim the key before writing. A concurrent call with the same key blocks
  -- on the unique index, then sees the conflict and returns the winner's row.
  INSERT INTO public.trip_copy_events (
    idempotency_key, operation, actor_wallet,
    source_kind, source_id, target_kind, target_id, summary
  ) VALUES (
    p_idempotency_key,
    CASE WHEN p_source_kind = 'template' THEN 'template_to_trip' ELSE 'trip_to_trip' END,
    v_wallet,
    p_source_kind, p_source_id, 'trip', v_trip_id::TEXT,
    jsonb_build_object(
      'member_count', jsonb_array_length(v_members),
      'recurring_rule_count', jsonb_array_length(v_rules),
      'has_dates', v_starts IS NOT NULL OR v_ends IS NOT NULL,
      'excluded', jsonb_build_array('expenses', 'shares', 'payments', 'balances', 'settled')
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trips WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  INSERT INTO public.trips (
    id, name, description, members, expense_ids, settled, created_by_wallet,
    starts_on, ends_on, recurring_rules, permissions,
    source_template_id, copied_from_trip_id
  ) VALUES (
    v_trip_id,
    v_name,
    NULLIF(btrim(COALESCE(p_trip ->> 'description', '')), ''),
    v_members,
    ARRAY[]::TEXT[],          -- history is never copied
    FALSE,
    v_wallet,
    v_starts,
    v_ends,
    v_rules,
    COALESCE(p_trip -> 'permissions', '{}'::jsonb),
    CASE WHEN p_source_kind = 'template' THEN p_source_id END,
    CASE WHEN p_source_kind = 'trip' THEN p_source_id END
  );

  RETURN QUERY SELECT * FROM public.trips WHERE id = v_trip_id;
END;
$fn$;

-- ── save_trip_template ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.save_trip_template(
  p_idempotency_key TEXT,
  p_source_trip_id  TEXT,
  p_template        JSONB
)
RETURNS SETOF public.trip_templates
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $fn$
DECLARE
  v_wallet      TEXT := public.current_wallet();
  v_event       public.trip_copy_events%ROWTYPE;
  v_template_id UUID := gen_random_uuid();
  v_name        TEXT := btrim(COALESCE(p_template ->> 'name', ''));
  v_members     JSONB := COALESCE(p_template -> 'members', '[]'::jsonb);
  v_rules       JSONB := COALESCE(p_template -> 'recurring_rules', '[]'::jsonb);
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'COPY_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) < 16 THEN
    RAISE EXCEPTION 'COPY_INVALID_KEY';
  END IF;

  SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trip_templates WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  IF v_name = '' THEN
    RAISE EXCEPTION 'COPY_INVALID_TEMPLATE: name is required';
  END IF;
  IF jsonb_typeof(v_members) <> 'array' OR jsonb_typeof(v_rules) <> 'array' THEN
    RAISE EXCEPTION 'COPY_INVALID_TEMPLATE: members and recurring_rules must be arrays';
  END IF;

  PERFORM 1 FROM public.trips WHERE id::TEXT = p_source_trip_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COPY_SOURCE_NOT_FOUND';
  END IF;

  INSERT INTO public.trip_copy_events (
    idempotency_key, operation, actor_wallet,
    source_kind, source_id, target_kind, target_id, summary
  ) VALUES (
    p_idempotency_key, 'trip_to_template', v_wallet,
    'trip', p_source_trip_id, 'template', v_template_id::TEXT,
    jsonb_build_object(
      'member_count', jsonb_array_length(v_members),
      'recurring_rule_count', jsonb_array_length(v_rules),
      'excluded', jsonb_build_array('expenses', 'shares', 'payments', 'balances', 'settled')
    )
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  IF NOT FOUND THEN
    SELECT * INTO v_event FROM public.trip_copy_events WHERE idempotency_key = p_idempotency_key;
    IF v_event.actor_wallet <> v_wallet THEN
      RAISE EXCEPTION 'COPY_KEY_CONFLICT';
    END IF;
    RETURN QUERY SELECT * FROM public.trip_templates WHERE id::TEXT = v_event.target_id;
    RETURN;
  END IF;

  INSERT INTO public.trip_templates (
    id, owner_wallet, name, description, members, recurring_rules,
    permissions, duration_days, source_trip_id
  ) VALUES (
    v_template_id,
    v_wallet,
    v_name,
    NULLIF(btrim(COALESCE(p_template ->> 'description', '')), ''),
    v_members,
    v_rules,
    COALESCE(p_template -> 'permissions', '{}'::jsonb),
    NULLIF(p_template ->> 'duration_days', '')::INT,
    p_source_trip_id
  );

  RETURN QUERY SELECT * FROM public.trip_templates WHERE id = v_template_id;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.create_trip_from_copy(TEXT, TEXT, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.save_trip_template(TEXT, TEXT, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0008', '0008_trip_templates', 'trip_templates_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0009_contacts_member_profiles.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0009: Reusable contacts & member profiles (#322)
-- ============================================================================
-- A private address book so names and wallets are not retyped for every trip.
--
-- Guarantees enforced by the database, not trusted from the client:
--   1. Contacts are private: every policy is owner_wallet = current_wallet().
--   2. Duplicates are detected by canonical wallet address, never by name:
--      UNIQUE (owner_wallet, wallet_address) on the upper-cased address.
--   3. Only the wallet's owner can verify it. wallet_verified/claimed_by_wallet
--      are writable solely by claim_contact_profile, which requires a session
--      signed by that very wallet.
--   4. A wallet already on a contact is never swapped in place. The change is
--      recorded in contact_wallet_changes, visible to every member of the
--      affected active trips, and applies only after the notice period.
--      Historic shares and payments are never rewritten.
-- See docs/DESIGN_CONTACTS.md.

-- ── Contacts ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.contacts (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_wallet        TEXT        NOT NULL,
  display_name        TEXT        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  wallet_address      TEXT        CHECK (wallet_address IS NULL OR wallet_address ~ '^G[A-Z2-7]{55}$'),
  wallet_verified     BOOLEAN     NOT NULL DEFAULT FALSE,
  claimed_by_wallet   TEXT,
  verified_at         TIMESTAMPTZ,
  invite_destination  TEXT        CHECK (invite_destination IS NULL OR length(invite_destination) <= 254),
  invite_channel      TEXT        CHECK (invite_channel IS NULL OR invite_channel IN ('email', 'phone', 'other')),
  -- SHA-256 of a one-time claim token; the token itself is never stored.
  claim_token_hash    TEXT,
  claim_expires_at    TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS contacts_owner_wallet_unique_idx
  ON public.contacts (owner_wallet, wallet_address)
  WHERE wallet_address IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS contacts_claim_token_hash_idx
  ON public.contacts (claim_token_hash)
  WHERE claim_token_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_contacts_owner_name
  ON public.contacts (owner_wallet, display_name);

-- Canonicalises input and protects the verification columns. Functions below
-- that are allowed to touch them set stellar_star.contact_privileged for the
-- current transaction only.
CREATE OR REPLACE FUNCTION public.guard_contact_row()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  privileged BOOLEAN := COALESCE(current_setting('stellar_star.contact_privileged', true), '') = 'on';
BEGIN
  NEW.display_name := btrim(NEW.display_name);
  NEW.wallet_address := NULLIF(upper(btrim(COALESCE(NEW.wallet_address, ''))), '');
  NEW.invite_destination := NULLIF(btrim(COALESCE(NEW.invite_destination, '')), '');

  IF privileged THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW.wallet_verified := FALSE;
    NEW.claimed_by_wallet := NULL;
    NEW.verified_at := NULL;
    RETURN NEW;
  END IF;

  -- UPDATE by the owner.
  NEW.owner_wallet := OLD.owner_wallet;
  NEW.wallet_verified := OLD.wallet_verified;
  NEW.claimed_by_wallet := OLD.claimed_by_wallet;
  NEW.verified_at := OLD.verified_at;

  IF OLD.wallet_address IS NOT NULL
     AND NEW.wallet_address IS DISTINCT FROM OLD.wallet_address THEN
    RAISE EXCEPTION 'CONTACT_WALLET_CHANGE_REQUIRES_NOTICE'
      USING HINT = 'Use request_contact_wallet_change so affected trips are notified first.';
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_01_contacts_guard ON public.contacts;
CREATE TRIGGER trg_01_contacts_guard
  BEFORE INSERT OR UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.guard_contact_row();

DROP TRIGGER IF EXISTS trg_02_contacts_set_updated_at ON public.contacts;
CREATE TRIGGER trg_02_contacts_set_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contacts_select_owner ON public.contacts;
CREATE POLICY contacts_select_owner ON public.contacts
  FOR SELECT USING (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_insert_owner ON public.contacts;
CREATE POLICY contacts_insert_owner ON public.contacts
  FOR INSERT WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_update_owner ON public.contacts;
CREATE POLICY contacts_update_owner ON public.contacts
  FOR UPDATE USING      (owner_wallet = public.current_wallet())
             WITH CHECK (owner_wallet = public.current_wallet());

DROP POLICY IF EXISTS contacts_delete_owner ON public.contacts;
CREATE POLICY contacts_delete_owner ON public.contacts
  FOR DELETE USING (owner_wallet = public.current_wallet());

GRANT SELECT, INSERT, UPDATE, DELETE ON public.contacts TO authenticated;

-- ── Wallet change history ───────────────────────────────────────────────────
-- Written only by the functions below. Readable by the contact's owner and by
-- every member of an affected trip, which is how those groups are notified.
CREATE TABLE IF NOT EXISTS public.contact_wallet_changes (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id         UUID        NOT NULL REFERENCES public.contacts (id) ON DELETE CASCADE,
  owner_wallet       TEXT        NOT NULL,
  contact_name       TEXT        NOT NULL,
  old_wallet         TEXT,
  new_wallet         TEXT        NOT NULL CHECK (new_wallet ~ '^G[A-Z2-7]{55}$'),
  status             TEXT        NOT NULL DEFAULT 'pending_notice'
                     CHECK (status IN ('pending_notice', 'applied', 'cancelled')),
  affected_trip_ids  TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  notice_until       TIMESTAMPTZ NOT NULL,
  verified           BOOLEAN     NOT NULL DEFAULT FALSE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_contact_wallet_changes_contact_created_at
  ON public.contact_wallet_changes (contact_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_contact_wallet_changes_affected_trips
  ON public.contact_wallet_changes USING GIN (affected_trip_ids);

-- At most one pending change per contact.
CREATE UNIQUE INDEX IF NOT EXISTS contact_wallet_changes_one_pending_idx
  ON public.contact_wallet_changes (contact_id)
  WHERE status = 'pending_notice';

ALTER TABLE public.contact_wallet_changes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS contact_wallet_changes_select_party ON public.contact_wallet_changes;
CREATE POLICY contact_wallet_changes_select_party ON public.contact_wallet_changes
  FOR SELECT USING (
    owner_wallet = public.current_wallet()
    OR EXISTS (
      SELECT 1 FROM public.trips t
       WHERE t.id::TEXT = ANY (affected_trip_ids)
         AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

GRANT SELECT ON public.contact_wallet_changes TO authenticated;

-- ── request_contact_wallet_change ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.request_contact_wallet_change(
  p_contact_id  UUID,
  p_new_wallet  TEXT
)
RETURNS SETOF public.contact_wallet_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet   TEXT := public.current_wallet();
  v_contact  public.contacts%ROWTYPE;
  v_new      TEXT := upper(btrim(COALESCE(p_new_wallet, '')));
  v_affected TEXT[];
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM public.contacts
   WHERE id = p_contact_id AND owner_wallet = v_wallet
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_NOT_FOUND';
  END IF;

  IF v_new !~ '^G[A-Z2-7]{55}$' THEN
    RAISE EXCEPTION 'CONTACT_INVALID_WALLET';
  END IF;
  IF v_new = v_contact.wallet_address THEN
    RAISE EXCEPTION 'CONTACT_WALLET_UNCHANGED';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts
              WHERE owner_wallet = v_wallet AND wallet_address = v_new AND id <> p_contact_id) THEN
    RAISE EXCEPTION 'CONTACT_DUPLICATE_WALLET';
  END IF;

  UPDATE public.contact_wallet_changes
     SET status = 'cancelled'
   WHERE contact_id = p_contact_id AND status = 'pending_notice';

  -- Active trips the owner shares with the old wallet. Settled trips are
  -- history and are left alone.
  SELECT COALESCE(array_agg(t.id::TEXT), ARRAY[]::TEXT[]) INTO v_affected
    FROM public.trips t
   WHERE v_contact.wallet_address IS NOT NULL
     AND t.settled = FALSE
     AND t.member_wallets @> ARRAY[v_wallet]
     AND t.member_wallets @> ARRAY[v_contact.wallet_address];

  RETURN QUERY
  INSERT INTO public.contact_wallet_changes (
    contact_id, owner_wallet, contact_name, old_wallet, new_wallet,
    affected_trip_ids, notice_until, verified
  ) VALUES (
    p_contact_id, v_wallet, v_contact.display_name, v_contact.wallet_address, v_new,
    v_affected,
    CASE WHEN cardinality(v_affected) = 0 THEN NOW() ELSE NOW() + INTERVAL '24 hours' END,
    -- An address typed by the owner is never verified; only a claim is.
    FALSE
  )
  RETURNING *;
END;
$fn$;

-- ── apply / cancel ──────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.apply_contact_wallet_change(p_change_id UUID)
RETURNS SETOF public.contacts
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_wallet TEXT := public.current_wallet();
  v_change public.contact_wallet_changes%ROWTYPE;
BEGIN
  IF v_wallet IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_change FROM public.contact_wallet_changes
   WHERE id = p_change_id AND owner_wallet = v_wallet
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_CHANGE_NOT_FOUND';
  END IF;
  IF v_change.status <> 'pending_notice' THEN
    RAISE EXCEPTION 'CONTACT_CHANGE_NOT_PENDING';
  END IF;
  IF cardinality(v_change.affected_trip_ids) > 0 AND v_change.notice_until > NOW() THEN
    RAISE EXCEPTION 'CONTACT_NOTICE_PERIOD_ACTIVE: affected trips are still being notified until %',
      v_change.notice_until;
  END IF;

  PERFORM set_config('stellar_star.contact_privileged', 'on', true);

  UPDATE public.contact_wallet_changes
     SET status = 'applied', applied_at = NOW()
   WHERE id = p_change_id;

  RETURN QUERY
  UPDATE public.contacts
     SET wallet_address    = v_change.new_wallet,
         wallet_verified   = v_change.verified,
         claimed_by_wallet = CASE WHEN v_change.verified THEN v_change.new_wallet END,
         verified_at       = CASE WHEN v_change.verified THEN NOW() END
   WHERE id = v_change.contact_id
  RETURNING *;

  PERFORM set_config('stellar_star.contact_privileged', 'off', true);
END;
$fn$;

CREATE OR REPLACE FUNCTION public.cancel_contact_wallet_change(p_change_id UUID)
RETURNS SETOF public.contact_wallet_changes
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
BEGIN
  IF public.current_wallet() IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  UPDATE public.contact_wallet_changes
     SET status = 'cancelled'
   WHERE id = p_change_id
     AND owner_wallet = public.current_wallet()
     AND status = 'pending_notice'
  RETURNING *;
END;
$fn$;

-- ── claim_contact_profile ───────────────────────────────────────────────────
-- The wallet owner proves control by signing in (the session JWT carries the
-- signature-verified wallet) and presenting the one-time claim token.
CREATE OR REPLACE FUNCTION public.claim_contact_profile(p_token_hash TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_claimant TEXT := public.current_wallet();
  v_contact  public.contacts%ROWTYPE;
  v_change   public.contact_wallet_changes%ROWTYPE;
BEGIN
  IF v_claimant IS NULL THEN
    RAISE EXCEPTION 'CONTACT_UNAUTHENTICATED' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contact FROM public.contacts
   WHERE claim_token_hash = p_token_hash
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_INVALID';
  END IF;
  IF v_contact.claim_expires_at IS NULL OR v_contact.claim_expires_at <= NOW() THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_EXPIRED';
  END IF;
  IF v_contact.owner_wallet = v_claimant THEN
    RAISE EXCEPTION 'CONTACT_CLAIM_SELF';
  END IF;
  IF EXISTS (SELECT 1 FROM public.contacts
              WHERE owner_wallet = v_contact.owner_wallet
                AND wallet_address = v_claimant
                AND id <> v_contact.id) THEN
    RAISE EXCEPTION 'CONTACT_DUPLICATE_WALLET';
  END IF;

  PERFORM set_config('stellar_star.contact_privileged', 'on', true);

  -- One-time token: consumed whatever happens next.
  UPDATE public.contacts SET claim_token_hash = NULL, claim_expires_at = NULL
   WHERE id = v_contact.id;

  IF v_contact.wallet_address IS NULL OR v_contact.wallet_address = v_claimant THEN
    -- No address in use yet, or the claim confirms the one already entered:
    -- nothing historic changes, so verify immediately.
    UPDATE public.contacts
       SET wallet_address = v_claimant, wallet_verified = TRUE,
           claimed_by_wallet = v_claimant, verified_at = NOW()
     WHERE id = v_contact.id;

    PERFORM set_config('stellar_star.contact_privileged', 'off', true);
    RETURN jsonb_build_object(
      'status', 'verified',
      'contact_name', v_contact.display_name,
      'owner_wallet', v_contact.owner_wallet
    );
  END IF;

  -- The claimant controls a different wallet than the one on file. Treat it as
  -- an address change, so the owner's active trips are notified first.
  UPDATE public.contact_wallet_changes SET status = 'cancelled'
   WHERE contact_id = v_contact.id AND status = 'pending_notice';

  INSERT INTO public.contact_wallet_changes (
    contact_id, owner_wallet, contact_name, old_wallet, new_wallet,
    affected_trip_ids, notice_until, verified
  )
  SELECT v_contact.id, v_contact.owner_wallet, v_contact.display_name,
         v_contact.wallet_address, v_claimant, affected,
         CASE WHEN cardinality(affected) = 0 THEN NOW() ELSE NOW() + INTERVAL '24 hours' END,
         TRUE
    FROM (
      SELECT COALESCE(array_agg(t.id::TEXT), ARRAY[]::TEXT[]) AS affected
        FROM public.trips t
       WHERE t.settled = FALSE
         AND t.member_wallets @> ARRAY[v_contact.owner_wallet]
         AND t.member_wallets @> ARRAY[v_contact.wallet_address]
    ) a
  RETURNING * INTO v_change;

  PERFORM set_config('stellar_star.contact_privileged', 'off', true);
  RETURN jsonb_build_object(
    'status', 'pending_notice',
    'contact_name', v_contact.display_name,
    'owner_wallet', v_contact.owner_wallet,
    'notice_until', v_change.notice_until
  );
END;
$fn$;

REVOKE ALL ON FUNCTION public.request_contact_wallet_change(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_contact_wallet_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.cancel_contact_wallet_change(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.claim_contact_profile(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_contact_wallet_change(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.apply_contact_wallet_change(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.cancel_contact_wallet_change(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.claim_contact_profile(TEXT) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0009', '0009_contacts_member_profiles', 'contacts_member_profiles_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0010_recurring_expenses.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0010: Recurring expense templates & scheduled drafts
-- (issue #319)
-- ============================================================================
-- Rent, utilities and subscriptions repeat. A template describes the series;
-- a scheduled job (or the trip page) turns each due occurrence into a DRAFT.
-- A draft is a suggestion: it becomes an expense only when a member reviews it
-- in the normal expense form and saves it. Nothing in this schema can move
-- money or request a wallet signature.

-- ─── Templates ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.recurring_expense_templates (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id            UUID REFERENCES public.trips (id) ON DELETE CASCADE,
  title              TEXT        NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  description        TEXT        CHECK (description IS NULL OR char_length(description) <= 100),
  category           TEXT        CHECK (category IS NULL OR category IN (
                       'food', 'groceries', 'lodging', 'transport', 'activities', 'shopping',
                       'utilities', 'rent', 'subscriptions', 'health', 'other'
                     )),
  tags               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[] CHECK (cardinality(tags) <= 10),
  currency           TEXT        NOT NULL DEFAULT 'XLM',
  amount_kind        TEXT        NOT NULL CHECK (amount_kind IN ('fixed', 'variable')),
  amount             TEXT        CHECK (amount IS NULL OR amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  split_mode         TEXT        NOT NULL CHECK (split_mode IN ('equal', 'custom')),
  paid_by_member_id  TEXT        NOT NULL,
  members            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cadence_unit       TEXT        NOT NULL CHECK (cadence_unit IN ('day', 'week', 'month', 'year')),
  cadence_interval   INT         NOT NULL CHECK (cadence_interval BETWEEN 1 AND 365),
  start_date         DATE        NOT NULL,
  end_date           DATE,
  -- Earliest date the generator may produce; moved forward on resume so a
  -- pause is never back-filled.
  generate_from      DATE        NOT NULL,
  reminder_lead_days INT         CHECK (reminder_lead_days IS NULL OR reminder_lead_days BETWEEN 0 AND 30),
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'ended')),
  version            INT         NOT NULL DEFAULT 1,
  created_by_wallet  TEXT        NOT NULL,
  member_wallets     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_templates_dates_check CHECK (end_date IS NULL OR end_date >= start_date),
  CONSTRAINT recurring_templates_fixed_amount_check CHECK (amount_kind <> 'fixed' OR amount IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_recurring_templates_member_wallets
  ON public.recurring_expense_templates USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_trip
  ON public.recurring_expense_templates (trip_id, created_at);
CREATE INDEX IF NOT EXISTS idx_recurring_templates_active
  ON public.recurring_expense_templates (id) WHERE status = 'active';

-- Same integrity pipeline as expenses/trips: identity frozen, access array
-- derived from members (never trusted from the client), updated_at stamped.
DROP TRIGGER IF EXISTS trg_01_recurring_templates_freeze_identity ON public.recurring_expense_templates;
CREATE TRIGGER trg_01_recurring_templates_freeze_identity
  BEFORE UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

DROP TRIGGER IF EXISTS trg_02_recurring_templates_sync_member_wallets ON public.recurring_expense_templates;
CREATE TRIGGER trg_02_recurring_templates_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

DROP TRIGGER IF EXISTS trg_03_recurring_templates_set_updated_at ON public.recurring_expense_templates;
CREATE TRIGGER trg_03_recurring_templates_set_updated_at
  BEFORE UPDATE ON public.recurring_expense_templates
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.recurring_expense_templates ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_templates_select_members ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_select_members ON public.recurring_expense_templates
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

DROP POLICY IF EXISTS recurring_templates_insert_own ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_insert_own ON public.recurring_expense_templates
  FOR INSERT TO authenticated
  WITH CHECK (public.current_wallet() IS NOT NULL AND created_by_wallet = public.current_wallet());

DROP POLICY IF EXISTS recurring_templates_update_members ON public.recurring_expense_templates;
CREATE POLICY recurring_templates_update_members ON public.recurring_expense_templates
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()])
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

-- No DELETE policy: a series is ended, not deleted, so the drafts and expenses
-- it produced keep a valid source.

-- ─── Occurrence exceptions (skip / edit one future occurrence) ──────────────

CREATE TABLE IF NOT EXISTS public.recurring_expense_exceptions (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id       UUID        NOT NULL REFERENCES public.recurring_expense_templates (id) ON DELETE CASCADE,
  occurrence_date   DATE        NOT NULL,
  action            TEXT        NOT NULL CHECK (action IN ('skip', 'override')),
  overrides         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT recurring_exceptions_one_per_occurrence UNIQUE (template_id, occurrence_date)
);

ALTER TABLE public.recurring_expense_exceptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recurring_exceptions_members ON public.recurring_expense_exceptions;
CREATE POLICY recurring_exceptions_members ON public.recurring_expense_exceptions
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.recurring_expense_templates t
      WHERE t.id = recurring_expense_exceptions.template_id
        AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.recurring_expense_templates t
      WHERE t.id = recurring_expense_exceptions.template_id
        AND t.member_wallets @> ARRAY[public.current_wallet()]
    )
  );

-- ─── Drafts ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_drafts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id        UUID        NOT NULL REFERENCES public.recurring_expense_templates (id),
  template_version   INT         NOT NULL,
  trip_id            UUID,
  occurrence_date    DATE        NOT NULL,
  payload            JSONB       NOT NULL,
  status             TEXT        NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'saved', 'dismissed')),
  expense_id         UUID REFERENCES public.expenses (id) ON DELETE SET NULL,
  member_wallets     TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at        TIMESTAMPTZ,
  resolved_by_wallet TEXT,
  -- The idempotency key: one draft per occurrence, however often the job runs.
  CONSTRAINT expense_drafts_one_per_occurrence UNIQUE (template_id, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_expense_drafts_member_wallets
  ON public.expense_drafts USING GIN (member_wallets);
CREATE INDEX IF NOT EXISTS idx_expense_drafts_trip_occurrence
  ON public.expense_drafts (trip_id, occurrence_date);

-- Access and scope come from the template, never from the inserting client;
-- once created, the snapshot (payload, source, date) is immutable.
CREATE OR REPLACE FUNCTION public.prepare_expense_draft()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
DECLARE
  tmpl RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT trip_id, member_wallets INTO tmpl
      FROM public.recurring_expense_templates
     WHERE id = NEW.template_id;
    NEW.trip_id := tmpl.trip_id;
    NEW.member_wallets := COALESCE(tmpl.member_wallets, ARRAY[]::TEXT[]);
    NEW.status := 'pending';
    NEW.expense_id := NULL;
    NEW.resolved_at := NULL;
    NEW.resolved_by_wallet := NULL;
  ELSE
    NEW.id := OLD.id;
    NEW.template_id := OLD.template_id;
    NEW.template_version := OLD.template_version;
    NEW.trip_id := OLD.trip_id;
    NEW.occurrence_date := OLD.occurrence_date;
    NEW.payload := OLD.payload;
    NEW.member_wallets := OLD.member_wallets;
    NEW.created_at := OLD.created_at;
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_01_expense_drafts_prepare ON public.expense_drafts;
CREATE TRIGGER trg_01_expense_drafts_prepare
  BEFORE INSERT OR UPDATE ON public.expense_drafts
  FOR EACH ROW EXECUTE FUNCTION public.prepare_expense_draft();

ALTER TABLE public.expense_drafts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_drafts_select_members ON public.expense_drafts;
CREATE POLICY expense_drafts_select_members ON public.expense_drafts
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

-- member_wallets is copied from the template by the trigger above, so this
-- check means "the inserting wallet is a member of the source template".
DROP POLICY IF EXISTS expense_drafts_insert_members ON public.expense_drafts;
CREATE POLICY expense_drafts_insert_members ON public.expense_drafts
  FOR INSERT TO authenticated
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

DROP POLICY IF EXISTS expense_drafts_update_members ON public.expense_drafts;
CREATE POLICY expense_drafts_update_members ON public.expense_drafts
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()])
  WITH CHECK (public.current_wallet() IS NOT NULL AND member_wallets @> ARRAY[public.current_wallet()]);

GRANT SELECT, INSERT, UPDATE ON public.recurring_expense_templates TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recurring_expense_exceptions TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.expense_drafts TO authenticated;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0010', '0010_recurring_expenses', 'recurring_expenses_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0011_trip_budgets.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0011: Trip budgets & spending alerts (issue #320)
-- ============================================================================
-- Budgets are display-only targets. They never touch amounts, shares or
-- settlement; every check below is about visibility and alert bookkeeping.

CREATE TABLE IF NOT EXISTS public.trip_budgets (
  trip_id           UUID PRIMARY KEY REFERENCES public.trips (id) ON DELETE CASCADE,
  currency          TEXT        NOT NULL DEFAULT 'XLM',
  total_amount      TEXT        CHECK (total_amount IS NULL OR total_amount ~ '^[0-9]+(\.[0-9]{1,7})?$'),
  category_caps     JSONB       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(category_caps) = 'object'),
  thresholds        INT[]       NOT NULL DEFAULT ARRAY[50, 80, 100]
                      CHECK (cardinality(thresholds) <= 6 AND 0 < ALL (thresholds) AND 200 >= ALL (thresholds)),
  version           INT         NOT NULL DEFAULT 1,
  created_by_wallet TEXT        NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DROP TRIGGER IF EXISTS trg_01_trip_budgets_set_updated_at ON public.trip_budgets;
CREATE TRIGGER trg_01_trip_budgets_set_updated_at
  BEFORE UPDATE ON public.trip_budgets
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- One row per threshold crossing. `cleared_at` is set when spend falls back
-- below the threshold, re-arming it; the partial unique index guarantees a
-- crossing fires exactly once even when several members' browsers evaluate it
-- at the same moment.
CREATE TABLE IF NOT EXISTS public.budget_alerts (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id           UUID        NOT NULL REFERENCES public.trips (id) ON DELETE CASCADE,
  scope             TEXT        NOT NULL,
  threshold         INT         NOT NULL CHECK (threshold > 0),
  spent_at_crossing TEXT        NOT NULL,
  fired_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  cleared_at        TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS budget_alerts_one_active_crossing
  ON public.budget_alerts (trip_id, scope, threshold)
  WHERE cleared_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_budget_alerts_trip_fired_at
  ON public.budget_alerts (trip_id, fired_at DESC);

-- Per-member mute. A member can only mute (or unmute) themselves.
CREATE TABLE IF NOT EXISTS public.budget_alert_mutes (
  trip_id       UUID        NOT NULL REFERENCES public.trips (id) ON DELETE CASCADE,
  member_wallet TEXT        NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (trip_id, member_wallet)
);

ALTER TABLE public.trip_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budget_alert_mutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS trip_budgets_members ON public.trip_budgets;
CREATE POLICY trip_budgets_members ON public.trip_budgets
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = trip_budgets.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = trip_budgets.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

DROP POLICY IF EXISTS budget_alerts_members ON public.budget_alerts;
CREATE POLICY budget_alerts_members ON public.budget_alerts
  FOR ALL TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alerts.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alerts.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

DROP POLICY IF EXISTS budget_alert_mutes_self ON public.budget_alert_mutes;
CREATE POLICY budget_alert_mutes_self ON public.budget_alert_mutes
  FOR ALL TO authenticated
  USING (public.current_wallet() IS NOT NULL AND member_wallet = public.current_wallet())
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND member_wallet = public.current_wallet()
    AND EXISTS (SELECT 1 FROM public.trips t
                WHERE t.id = budget_alert_mutes.trip_id AND t.member_wallets @> ARRAY[public.current_wallet()])
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON public.trip_budgets TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.budget_alerts TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.budget_alert_mutes TO authenticated;

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0011', '0011_trip_budgets', 'trip_budgets_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0014_settlement_proposals.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0014: Settlement proposals and confirmation (#328)
-- ============================================================================
-- Before payments begin, a member can freeze a "proposed settlement": the
-- exact expense versions, balances, assets and transfers it covers, with a
-- creator, an expiry and a deterministic content hash
-- (lib/settlement/proposal.ts). Members approve it, reject it with a reason,
-- or request an edit.
--
-- The hash is recomputed from `snapshot` by every reader; a row whose snapshot
-- does not hash to `content_hash` is treated as invalid, so a tampered
-- snapshot can never collect approvals. Each response records the hash it
-- answered, so an approval only ever counts for the exact snapshot approved.
--
-- Stored lifecycle is open | revoked | superseded | invalidated. "approved",
-- "rejected", "expired" and "invalidated by a material change" are derived
-- from the responses, `expires_at` and the live expenses.

CREATE TABLE IF NOT EXISTS public.settlement_proposals (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id        TEXT        NOT NULL,
  creator_wallet TEXT        NOT NULL,
  content_hash   TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  snapshot       JSONB       NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  status         TEXT        NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open', 'revoked', 'superseded', 'invalidated')),
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_reason TEXT        CHECK (revoked_reason IS NULL OR char_length(revoked_reason) <= 500),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_proposals_hash_unique UNIQUE (content_hash)
);

-- At most one open proposal per trip: proposing again supersedes, never stacks.
CREATE UNIQUE INDEX IF NOT EXISTS settlement_proposals_one_open_per_trip
  ON public.settlement_proposals (trip_id)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_settlement_proposals_trip_created_at
  ON public.settlement_proposals (trip_id, created_at DESC);

-- Append-only: a member's latest response is the one that counts.
CREATE TABLE IF NOT EXISTS public.settlement_proposal_responses (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id  UUID        NOT NULL REFERENCES public.settlement_proposals (id) ON DELETE CASCADE,
  member_id    TEXT        NOT NULL,
  wallet       TEXT        NOT NULL,
  decision     TEXT        NOT NULL CHECK (decision IN ('approve', 'reject', 'request_edit')),
  reason       TEXT        CHECK (reason IS NULL OR char_length(reason) <= 500),
  content_hash TEXT        NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT settlement_proposal_responses_reason_required
    CHECK (decision = 'approve' OR (reason IS NOT NULL AND char_length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS idx_settlement_proposal_responses_proposal_created_at
  ON public.settlement_proposal_responses (proposal_id, created_at);

DROP TRIGGER IF EXISTS trg_01_settlement_proposals_set_updated_at ON public.settlement_proposals;
CREATE TRIGGER trg_01_settlement_proposals_set_updated_at
  BEFORE UPDATE ON public.settlement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
ALTER TABLE public.settlement_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settlement_proposal_responses ENABLE ROW LEVEL SECURITY;

-- Trip members see and create proposals for their trips.
DROP POLICY IF EXISTS settlement_proposals_select_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_select_member ON public.settlement_proposals
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips t
     WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
  ));

DROP POLICY IF EXISTS settlement_proposals_insert_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_insert_member ON public.settlement_proposals
  FOR INSERT TO authenticated
  WITH CHECK (
    creator_wallet = public.current_wallet()
    AND status = 'open'
    AND EXISTS (
      SELECT 1 FROM public.trips t
       WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
    )
  );

-- Members may move an open proposal to superseded/invalidated (proposing again,
-- or recording a detected material change); only the creator may revoke.
-- The snapshot and hash themselves are frozen by the trigger below.
DROP POLICY IF EXISTS settlement_proposals_update_member ON public.settlement_proposals;
CREATE POLICY settlement_proposals_update_member ON public.settlement_proposals
  FOR UPDATE TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.trips t
     WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY (t.member_wallets)
  ))
  WITH CHECK (status <> 'revoked' OR creator_wallet = public.current_wallet());

CREATE OR REPLACE FUNCTION public.freeze_settlement_proposal()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.snapshot IS DISTINCT FROM OLD.snapshot
     OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
     OR NEW.trip_id IS DISTINCT FROM OLD.trip_id
     OR NEW.creator_wallet IS DISTINCT FROM OLD.creator_wallet
     OR NEW.expires_at IS DISTINCT FROM OLD.expires_at THEN
    RAISE EXCEPTION 'A settlement proposal snapshot is frozen; propose again instead.'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.status <> 'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Only an open proposal can change status.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_00_settlement_proposals_freeze ON public.settlement_proposals;
CREATE TRIGGER trg_00_settlement_proposals_freeze
  BEFORE UPDATE ON public.settlement_proposals
  FOR EACH ROW EXECUTE FUNCTION public.freeze_settlement_proposal();

DROP POLICY IF EXISTS settlement_proposal_responses_select_member ON public.settlement_proposal_responses;
CREATE POLICY settlement_proposal_responses_select_member ON public.settlement_proposal_responses
  FOR SELECT TO authenticated
  USING (EXISTS (
    SELECT 1 FROM public.settlement_proposals p
      JOIN public.trips t ON t.id::TEXT = p.trip_id
     WHERE p.id = proposal_id AND public.current_wallet() = ANY (t.member_wallets)
  ));

-- A member answers only for themselves, and only an open proposal.
DROP POLICY IF EXISTS settlement_proposal_responses_insert_self ON public.settlement_proposal_responses;
CREATE POLICY settlement_proposal_responses_insert_self ON public.settlement_proposal_responses
  FOR INSERT TO authenticated
  WITH CHECK (
    wallet = public.current_wallet()
    AND EXISTS (
      SELECT 1 FROM public.settlement_proposals p
        JOIN public.trips t ON t.id::TEXT = p.trip_id
       WHERE p.id = proposal_id
         AND p.status = 'open'
         AND p.expires_at > NOW()
         AND p.content_hash = settlement_proposal_responses.content_hash
         AND public.current_wallet() = ANY (t.member_wallets)
    )
  );

GRANT SELECT, INSERT, UPDATE ON public.settlement_proposals TO authenticated;
GRANT SELECT, INSERT ON public.settlement_proposal_responses TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0014', '0014_settlement_proposals', 'settlement_proposals_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0018_expense_disputes.sql
-- ============================================================================

-- #329 Disputes are off-chain review state. They never rewrite expenses,
-- installments, transaction hashes, or contract events.
CREATE TABLE IF NOT EXISTS public.expense_disputes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id TEXT NOT NULL,
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  share_member_id TEXT NOT NULL,
  opened_by_wallet TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('incorrect_amount','incorrect_split','not_shared','duplicate','already_paid','missing_context','other')),
  comment TEXT NOT NULL CHECK (char_length(btrim(comment)) BETWEEN 1 AND 2000),
  -- References to private receipt records only; raw evidence is never public.
  evidence_receipt_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[] CHECK (cardinality(evidence_receipt_ids) <= 5),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','resolved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  CONSTRAINT expense_disputes_resolution_state CHECK ((status = 'open' AND resolved_at IS NULL) OR (status IN ('upheld','resolved') AND resolved_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS expense_disputes_one_open_per_share
  ON public.expense_disputes (expense_id, share_member_id) WHERE status IN ('open','upheld');
CREATE INDEX IF NOT EXISTS expense_disputes_trip_created ON public.expense_disputes (trip_id, created_at DESC);

CREATE TABLE IF NOT EXISTS public.expense_dispute_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_id UUID NOT NULL REFERENCES public.expense_disputes(id) ON DELETE RESTRICT,
  actor_wallet TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('opened','upheld','dismissed','adjusted')),
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS expense_dispute_events_dispute_created ON public.expense_dispute_events (dispute_id, created_at);

CREATE OR REPLACE FUNCTION public.record_expense_dispute_opened()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO public.expense_dispute_events (dispute_id, actor_wallet, action, reason)
    VALUES (NEW.id, NEW.opened_by_wallet, 'opened', NEW.comment);
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_opened_event ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_opened_event AFTER INSERT ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.record_expense_dispute_opened();

ALTER TABLE public.expense_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_dispute_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_disputes_select_members ON public.expense_disputes;
CREATE POLICY expense_disputes_select_members ON public.expense_disputes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.trips t WHERE t.id::TEXT = trip_id AND public.current_wallet() = ANY(t.member_wallets)));
DROP POLICY IF EXISTS expense_disputes_insert_subject_member ON public.expense_disputes;
CREATE POLICY expense_disputes_insert_subject_member ON public.expense_disputes FOR INSERT TO authenticated
  WITH CHECK (opened_by_wallet = public.current_wallet()
    AND status = 'open' AND resolved_at IS NULL
    AND EXISTS (SELECT 1 FROM public.expenses e WHERE e.id = expense_id
      AND public.current_wallet() = ANY(e.member_wallets)
      AND e.members @> jsonb_build_array(jsonb_build_object('id', share_member_id))
      AND e.shares @> jsonb_build_array(jsonb_build_object('memberId', share_member_id))
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(e.members) m WHERE m->>'id' = share_member_id AND upper(m->>'walletAddress') = upper(public.current_wallet()))));

CREATE OR REPLACE FUNCTION public.validate_expense_dispute_evidence()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE receipt_id UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.expenses e, jsonb_array_elements(e.shares) s
    WHERE e.id = NEW.expense_id AND s->>'memberId' = NEW.share_member_id
      AND COALESCE((s->>'paid')::BOOLEAN, FALSE) = FALSE) THEN
    RAISE EXCEPTION 'Only an unpaid share can be disputed.' USING ERRCODE = '42501';
  END IF;
  FOREACH receipt_id IN ARRAY NEW.evidence_receipt_ids LOOP
    IF NOT EXISTS (SELECT 1 FROM public.expense_receipts r WHERE r.id = receipt_id
      AND r.expense_id = NEW.expense_id AND r.status = 'active'
      AND (r.uploaded_by_wallet = public.current_wallet()
        OR public.expense_has_permission(NEW.expense_id, 'receipts.manage'))) THEN
      RAISE EXCEPTION 'Evidence must reference an active private receipt available to you for this expense.' USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_evidence ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_evidence BEFORE INSERT ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_dispute_evidence();

-- Only trip owners/organizers with expense management permission may resolve.
DROP POLICY IF EXISTS expense_disputes_update_resolver ON public.expense_disputes;
CREATE POLICY expense_disputes_update_resolver ON public.expense_disputes FOR UPDATE TO authenticated
  USING (public.expense_has_permission(expense_id, 'expenses.manage'))
  WITH CHECK (public.expense_has_permission(expense_id, 'expenses.manage') AND status IN ('upheld','resolved') AND resolved_at IS NOT NULL);

DROP POLICY IF EXISTS expense_dispute_events_select_members ON public.expense_dispute_events;
CREATE POLICY expense_dispute_events_select_members ON public.expense_dispute_events FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.expense_disputes d JOIN public.trips t ON t.id::TEXT = d.trip_id
    WHERE d.id = dispute_id AND public.current_wallet() = ANY(t.member_wallets)));
DROP POLICY IF EXISTS expense_dispute_events_insert_actor ON public.expense_dispute_events;
CREATE POLICY expense_dispute_events_insert_actor ON public.expense_dispute_events FOR INSERT TO authenticated
  WITH CHECK (actor_wallet = public.current_wallet() AND EXISTS (
    SELECT 1 FROM public.expense_disputes d WHERE d.id = dispute_id AND d.status = 'open'
      AND ((action = 'opened' AND d.opened_by_wallet = public.current_wallet())
        OR (action <> 'opened' AND public.expense_has_permission(d.expense_id, 'expenses.manage')))));

-- Resolution event + state transition are atomic; a resolved state can never
-- exist without its action and reason in the append-only event log.
CREATE OR REPLACE FUNCTION public.resolve_expense_dispute(p_dispute_id UUID, p_action TEXT, p_reason TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE d public.expense_disputes%ROWTYPE;
BEGIN
  IF p_action NOT IN ('upheld','dismissed','adjusted') OR char_length(btrim(COALESCE(p_reason,''))) NOT BETWEEN 1 AND 1000 THEN
    RAISE EXCEPTION 'A valid resolution action and reason are required.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO d FROM public.expense_disputes WHERE id = p_dispute_id AND status = 'open' FOR UPDATE;
  IF NOT FOUND OR NOT public.expense_has_permission(d.expense_id, 'expenses.manage') THEN
    RAISE EXCEPTION 'You are not allowed to resolve this dispute.' USING ERRCODE = '42501';
  END IF;
  INSERT INTO public.expense_dispute_events (dispute_id, actor_wallet, action, reason)
    VALUES (d.id, public.current_wallet(), p_action, btrim(p_reason));
  UPDATE public.expense_disputes SET status = CASE WHEN p_action = 'upheld' THEN 'upheld' ELSE 'resolved' END,
    resolved_at = NOW() WHERE id = d.id;
END; $fn$;

CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_history()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Disputes are retained as an audit record.' USING ERRCODE = '42501'; END IF;
  IF NEW.trip_id IS DISTINCT FROM OLD.trip_id OR NEW.expense_id IS DISTINCT FROM OLD.expense_id
    OR NEW.share_member_id IS DISTINCT FROM OLD.share_member_id OR NEW.opened_by_wallet IS DISTINCT FROM OLD.opened_by_wallet
    OR NEW.category IS DISTINCT FROM OLD.category OR NEW.comment IS DISTINCT FROM OLD.comment
    OR NEW.evidence_receipt_ids IS DISTINCT FROM OLD.evidence_receipt_ids
    OR OLD.status <> 'open' OR NEW.status NOT IN ('upheld','resolved') OR NEW.resolved_at IS NULL THEN
    RAISE EXCEPTION 'Disputes are immutable; resolution must be recorded as an event.' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_freeze ON public.expense_disputes;
CREATE TRIGGER trg_expense_dispute_freeze BEFORE UPDATE OR DELETE ON public.expense_disputes
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_dispute_history();

CREATE OR REPLACE FUNCTION public.freeze_expense_dispute_events()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN RAISE EXCEPTION 'Dispute events are append-only.' USING ERRCODE = '42501'; END; $fn$;
DROP TRIGGER IF EXISTS trg_expense_dispute_events_freeze ON public.expense_dispute_events;
CREATE TRIGGER trg_expense_dispute_events_freeze BEFORE UPDATE OR DELETE ON public.expense_dispute_events
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_dispute_events();

GRANT SELECT, INSERT, UPDATE ON public.expense_disputes TO authenticated;
GRANT SELECT, INSERT ON public.expense_dispute_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_expense_dispute(UUID, TEXT, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.validate_expense_dispute_evidence() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_dispute_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_dispute_events() FROM PUBLIC;
NOTIFY pgrst, 'reload schema';
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0018', '0018_expense_disputes', 'expense_disputes_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0018_support_console_and_audit.sql
-- ============================================================================

-- ============================================================================
-- Migration 0018: Incident-Response & Support Console and Audit Logs (#314)
-- ============================================================================
-- 1. Creates support_audit_logs to log every staff customer data lookup.
-- 2. Creates support_corrective_actions for dual-control (Four-Eyes Principle)
--    exceptional financial state modifications.
-- 3. Enables RLS and performance indexes.

-- ─── 1. SUPPORT AUDIT LOGS ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_audit_logs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_identifier TEXT NOT NULL,
  query_type       TEXT NOT NULL,
  query_value      TEXT NOT NULL,
  results_count    INT  NOT NULL DEFAULT 0,
  ip_address       TEXT NOT NULL,
  user_agent       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_created_at
  ON public.support_audit_logs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_audit_logs_staff
  ON public.support_audit_logs (staff_identifier);

ALTER TABLE public.support_audit_logs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_audit_logs_select_authenticated ON public.support_audit_logs;
CREATE POLICY support_audit_logs_select_authenticated ON public.support_audit_logs
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS support_audit_logs_insert_authenticated ON public.support_audit_logs;
CREATE POLICY support_audit_logs_insert_authenticated ON public.support_audit_logs
  FOR INSERT TO authenticated WITH CHECK (true);

GRANT SELECT, INSERT ON public.support_audit_logs TO authenticated;

-- ─── 2. DUAL-CONTROL CORRECTIVE ACTIONS ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.support_corrective_actions (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  action_type      TEXT NOT NULL,
  target_id        TEXT NOT NULL,
  target_type      TEXT NOT NULL,
  ticket_ref       TEXT NOT NULL,
  reason           TEXT NOT NULL,
  details          JSONB NOT NULL DEFAULT '{}'::jsonb,
  proposed_by      TEXT NOT NULL,
  proposed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  approved_by      TEXT,
  approved_at      TIMESTAMPTZ,
  status           TEXT NOT NULL CHECK (status IN ('pending_approval', 'approved', 'executed', 'rejected', 'expired')),
  execution_result JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_corrective_actions_status
  ON public.support_corrective_actions (status, proposed_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_corrective_actions_ticket
  ON public.support_corrective_actions (ticket_ref);

ALTER TABLE public.support_corrective_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS support_corrective_actions_select_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_select_authenticated ON public.support_corrective_actions
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS support_corrective_actions_insert_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_insert_authenticated ON public.support_corrective_actions
  FOR INSERT TO authenticated WITH CHECK (true);

DROP POLICY IF EXISTS support_corrective_actions_update_authenticated ON public.support_corrective_actions;
CREATE POLICY support_corrective_actions_update_authenticated ON public.support_corrective_actions
  FOR UPDATE TO authenticated USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE ON public.support_corrective_actions TO authenticated;

-- ─── 3. RECORD MIGRATION ─────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0018', '0018_support_console_and_audit', 'support_console_and_audit_314_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0011_export_audit_events.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0011: Export audit log (#324)
-- ============================================================================
-- Every portable-archive export request — served or refused — appends one row.
-- The archive route writes it with the caller's own session, before any data
-- is returned, and refuses the export if the write fails (fail closed).
--
-- Append-only: INSERT and SELECT policies only, so under RLS a wallet can read
-- its own export history but nobody can edit or delete it.

CREATE TABLE IF NOT EXISTS public.export_audit_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_wallet   TEXT        NOT NULL,
  export_kind    TEXT        NOT NULL CHECK (export_kind IN ('archive')),
  status         TEXT        NOT NULL CHECK (status IN ('served', 'rate_limited', 'forbidden', 'failed')),
  trip_ids       TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  trip_count     INT         NOT NULL DEFAULT 0 CHECK (trip_count >= 0),
  expense_count  INT         NOT NULL DEFAULT 0 CHECK (expense_count >= 0),
  byte_size      INT         NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  -- SHA-256 of the archive body, so a file can later be matched to its record.
  content_sha256 TEXT,
  request_id     TEXT,
  -- Salted hash, not the raw IP: enough to spot abuse, not to track people.
  client_ip_hash TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_export_audit_events_actor_created_at
  ON public.export_audit_events (actor_wallet, created_at DESC);

ALTER TABLE public.export_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS export_audit_events_select_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_select_actor ON public.export_audit_events
  FOR SELECT USING (actor_wallet = public.current_wallet());

DROP POLICY IF EXISTS export_audit_events_insert_actor ON public.export_audit_events;
CREATE POLICY export_audit_events_insert_actor ON public.export_audit_events
  FOR INSERT WITH CHECK (actor_wallet = public.current_wallet());

GRANT SELECT, INSERT ON public.export_audit_events TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0011', '0011_export_audit_events', 'export_audit_events_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0012_share_installments.sql
-- ============================================================================

-- ============================================================================
-- Stellar-star Migration 0012: Partial settlement installments (issue #325)
-- ============================================================================
-- A share can now be settled over several on-chain payments. Each payment is
-- appended to the share's `installments` array inside `expenses.shares`; the
-- share flips to `paid` only when the installments sum to exactly what it owes.
--
-- `record_share_installment` is the only write path, and it is atomic:
--   * `SELECT ... FOR UPDATE` serializes concurrent installments on one expense,
--     so two payments racing for the same remaining balance cannot both fit.
--   * Amounts are compared in integer stroops (NUMERIC, never float).
--   * An installment that would exceed the remaining balance is rejected with
--     SQLSTATE 23514 (check_violation). There is no implicit credit.
--   * Re-recording a transaction hash already on the share is a no-op, which
--     keeps retry-after-submit and cross-device reconciliation idempotent.
--
-- Every statement is idempotent. Existing shares are untouched: a share with
-- no `installments` key behaves exactly as before.

CREATE OR REPLACE FUNCTION public.record_share_installment(
  p_expense_id  UUID,
  p_member_id   TEXT,
  p_installment JSONB
)
RETURNS SETOF public.expenses
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
  v_expense        public.expenses;
  v_shares         JSONB;
  v_share          JSONB;
  v_updated_shares JSONB := '[]'::jsonb;
  v_installments   JSONB;
  v_tx_hash        TEXT;
  v_amount_stroops NUMERIC;
  v_owed_stroops   NUMERIC;
  v_paid_stroops   NUMERIC;
  v_found          BOOLEAN := false;
  v_duplicate      BOOLEAN := false;
  v_all_paid       BOOLEAN := true;
  v_len            INT;
  v_idx            INT;
BEGIN
  v_tx_hash := lower(trim(p_installment ->> 'txHash'));
  IF v_tx_hash IS NULL OR v_tx_hash !~ '^[0-9a-f]{64}$' THEN
    RAISE EXCEPTION 'Installment txHash must be a 64-character hex transaction hash'
      USING ERRCODE = '22023';
  END IF;

  IF (p_installment ->> 'amountStroops') IS NULL
     OR (p_installment ->> 'amountStroops') !~ '^[0-9]{1,20}$' THEN
    RAISE EXCEPTION 'Installment amountStroops must be a non-negative integer string'
      USING ERRCODE = '22023';
  END IF;
  v_amount_stroops := (p_installment ->> 'amountStroops')::NUMERIC;
  IF v_amount_stroops <= 0 THEN
    RAISE EXCEPTION 'Installment amount must be greater than zero' USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_expense
    FROM public.expenses
   WHERE id = p_expense_id
     FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found' USING ERRCODE = 'P0002';
  END IF;

  -- Only a member of the expense may record a payment against it.
  IF public.current_wallet() IS NULL
     OR NOT (public.current_wallet() = ANY (v_expense.member_wallets)) THEN
    RAISE EXCEPTION 'Not a member of this expense' USING ERRCODE = '42501';
  END IF;

  v_shares := COALESCE(v_expense.shares, '[]'::jsonb);
  v_len := jsonb_array_length(v_shares);

  FOR v_idx IN 0..(v_len - 1) LOOP
    v_share := v_shares -> v_idx;

    IF (v_share ->> 'memberId') = p_member_id THEN
      v_found := true;
      v_installments := COALESCE(v_share -> 'installments', '[]'::jsonb);

      IF EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_installments) AS i
         WHERE lower(i ->> 'txHash') = v_tx_hash
      ) THEN
        v_duplicate := true;
      ELSE
        IF COALESCE((v_share ->> 'paid')::boolean, false) THEN
          RAISE EXCEPTION 'Share is already fully settled' USING ERRCODE = '23514';
        END IF;

        v_owed_stroops := (v_share ->> 'amount')::NUMERIC * 10000000;
        SELECT COALESCE(SUM((i ->> 'amountStroops')::NUMERIC), 0)
          INTO v_paid_stroops
          FROM jsonb_array_elements(v_installments) AS i;

        IF v_paid_stroops + v_amount_stroops > v_owed_stroops THEN
          RAISE EXCEPTION 'OVERPAYMENT: installment of % stroops exceeds remaining % stroops',
            v_amount_stroops, v_owed_stroops - v_paid_stroops
            USING ERRCODE = '23514';
        END IF;

        v_paid_stroops := v_paid_stroops + v_amount_stroops;
        v_installments := v_installments || jsonb_build_array(
          p_installment || jsonb_build_object('txHash', v_tx_hash)
        );
        v_share := v_share || jsonb_build_object(
          'installments', v_installments,
          'paidStroops', v_paid_stroops::TEXT,
          'paid', v_paid_stroops = v_owed_stroops
        );
        IF v_paid_stroops = v_owed_stroops THEN
          v_share := v_share || jsonb_build_object('txHash', v_tx_hash);
        END IF;
      END IF;
    END IF;

    IF NOT COALESCE((v_share ->> 'paid')::boolean, false) THEN
      v_all_paid := false;
    END IF;

    v_updated_shares := v_updated_shares || jsonb_build_array(v_share);
  END LOOP;

  IF NOT v_found THEN
    RAISE EXCEPTION 'Share not found on this expense' USING ERRCODE = 'P0002';
  END IF;

  IF v_duplicate THEN
    RETURN QUERY SELECT * FROM public.expenses WHERE id = p_expense_id;
    RETURN;
  END IF;

  RETURN QUERY UPDATE public.expenses
     SET shares = v_updated_shares,
         settled = v_all_paid,
         version = version + 1
   WHERE id = p_expense_id
   RETURNING *;
END;
$fn$;

GRANT EXECUTE ON FUNCTION public.record_share_installment(UUID, TEXT, JSONB) TO authenticated;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0012', '0012_share_installments', 'share_installments_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0013_privacy_retention_deletion.sql
-- ============================================================================

-- ============================================================================
-- Migration 0013: Privacy, Data Retention & Account Deletion (#310)
-- ============================================================================
-- 1. Creates deleted_accounts registry to invalidate stale sessions, realtime
--    subscriptions, and storage access for deleted accounts.
-- 2. Updates public.current_wallet() to fail closed (return NULL) for deleted accounts.
-- 3. Provides stored procedure public.delete_user_account for atomic off-chain erasure.

CREATE TABLE IF NOT EXISTS public.deleted_accounts (
  wallet_address TEXT PRIMARY KEY,
  deleted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason         TEXT NOT NULL DEFAULT 'user_request'
);

CREATE INDEX IF NOT EXISTS idx_deleted_accounts_deleted_at
  ON public.deleted_accounts (deleted_at DESC);

ALTER TABLE public.deleted_accounts ENABLE ROW LEVEL SECURITY;

-- Service role and authenticated users can read deletion status
DROP POLICY IF EXISTS "deleted_accounts_select_all" ON public.deleted_accounts;
CREATE POLICY "deleted_accounts_select_all" ON public.deleted_accounts
  FOR SELECT USING (true);

-- Only authenticated users for their own wallet can record deletion
DROP POLICY IF EXISTS "deleted_accounts_insert_self" ON public.deleted_accounts;
CREATE POLICY "deleted_accounts_insert_self" ON public.deleted_accounts
  FOR INSERT WITH CHECK (
    wallet_address = NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
  );

GRANT SELECT, INSERT ON public.deleted_accounts TO anon, authenticated;

-- ── Hardened current_wallet() ────────────────────────────────────────────────
-- Fails closed immediately for any session whose wallet is in deleted_accounts.
-- This revokes access across PostgREST RLS, Realtime subscriptions, and storage.
CREATE OR REPLACE FUNCTION public.current_wallet()
RETURNS TEXT
LANGUAGE SQL
STABLE
AS $fn$
  SELECT CASE
    WHEN EXISTS (
      SELECT 1 FROM public.deleted_accounts
       WHERE wallet_address = NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
    ) THEN NULL
    ELSE NULLIF(COALESCE(current_setting('request.jwt.claims', true)::jsonb ->> 'wallet_address', ''), '')
  END;
$fn$;

-- ── Atomic Deletion Stored Procedure ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.delete_user_account(p_wallet_address TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $fn$
DECLARE
  v_caller TEXT := public.current_wallet();
  v_target TEXT := btrim(p_wallet_address);
BEGIN
  -- Caller must be the account owner or executing via service_role (v_caller IS NULL)
  IF v_caller IS NOT NULL AND v_caller <> v_target THEN
    RAISE EXCEPTION 'Unauthorized: cannot delete another user account' USING ERRCODE = '42501';
  END IF;

  -- 1. Insert into deleted_accounts
  INSERT INTO public.deleted_accounts (wallet_address, deleted_at, reason)
  VALUES (v_target, NOW(), 'user_request')
  ON CONFLICT (wallet_address) DO UPDATE
    SET deleted_at = NOW();

  -- 2. Delete user profile
  DELETE FROM public.users WHERE wallet_address = v_target;

  -- 3. Delete owned contacts
  DELETE FROM public.contacts WHERE owner_wallet = v_target;

  -- 4. Revoke active invites
  UPDATE public.trip_invites
     SET revoked = true,
         revoked_at = NOW()
   WHERE created_by_wallet = v_target
     AND revoked = false;

  -- 5. Mark uploaded receipts as removed
  UPDATE public.expense_receipts
     SET status = 'removed',
         removal_reason = 'user',
         removed_at = NOW(),
         removed_by_wallet = v_target
   WHERE uploaded_by_wallet = v_target
     AND status <> 'removed';

  -- 6. Delete challenges
  DELETE FROM public.auth_challenges WHERE address = v_target;

  RETURN jsonb_build_object(
    'success', true,
    'wallet_address', v_target,
    'deleted_at', NOW()
  );
END;
$fn$;

REVOKE EXECUTE ON FUNCTION public.delete_user_account(TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.delete_user_account(TEXT) TO authenticated;

-- Record migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0013', '0013_privacy_retention_deletion', 'privacy_retention_310_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0019_expense_corrections_and_voids.sql
-- ============================================================================

-- 0019_expense_corrections_and_voids.sql
-- #316: Add reversals and corrections instead of destructive edits
-- Financial history should remain understandable after a mistake.
-- Replace the temptation to mutate or delete settled data with linked correction records.

-- 1. Add void and linked-correction columns to public.expenses
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS voided_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS voided_by_wallet TEXT,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS correction_of_expense_id UUID REFERENCES public.expenses(id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS correction_type TEXT,
  ADD COLUMN IF NOT EXISTS correction_reason TEXT;

-- 2. Constraints for voided and linked-correction fields
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_void_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_void_check CHECK (
        (voided = FALSE AND void_reason IS NULL AND voided_at IS NULL AND voided_by_wallet IS NULL) OR
        (voided = TRUE AND void_reason IS NOT NULL AND char_length(btrim(void_reason)) BETWEEN 1 AND 1000 AND voided_at IS NOT NULL AND voided_by_wallet IS NOT NULL)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_correction_type_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_correction_type_check CHECK (
        correction_type IS NULL OR correction_type IN ('reversal', 'adjustment', 'offset')
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_correction_link_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_correction_link_check CHECK (
        (correction_of_expense_id IS NULL AND correction_type IS NULL AND correction_reason IS NULL) OR
        (correction_of_expense_id IS NOT NULL AND correction_type IS NOT NULL AND correction_reason IS NOT NULL AND char_length(btrim(correction_reason)) BETWEEN 1 AND 1000)
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'expenses_no_self_correction_check'
  ) THEN
    ALTER TABLE public.expenses
      ADD CONSTRAINT expenses_no_self_correction_check CHECK (
        correction_of_expense_id IS NULL OR correction_of_expense_id <> id
      );
  END IF;
END $$;

-- 3. Indexes for fast lookup of voided expenses and linked correction chains
CREATE INDEX IF NOT EXISTS idx_expenses_voided
  ON public.expenses (voided) WHERE voided = TRUE;
CREATE INDEX IF NOT EXISTS idx_expenses_correction_of
  ON public.expenses (correction_of_expense_id) WHERE correction_of_expense_id IS NOT NULL;

-- 4. Immutable append-only audit event log for void and correction events
CREATE TABLE IF NOT EXISTS public.expense_audit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id UUID NOT NULL REFERENCES public.expenses(id) ON DELETE RESTRICT,
  action TEXT NOT NULL CHECK (action IN ('voided', 'correction_created', 'reversal_created', 'adjustment_created')),
  actor_wallet TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 1000),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_audit_events_expense_id
  ON public.expense_audit_events (expense_id, created_at DESC);

-- 5. Prevent destructive mutations on settled data and frozen voided rows
CREATE OR REPLACE FUNCTION public.prevent_destructive_expense_operations()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
DECLARE
  v_is_settled BOOLEAN;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_is_settled := OLD.settled OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.shares) s
      WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
        OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
    );
    IF v_is_settled THEN
      RAISE EXCEPTION 'A settled expense cannot be deleted. Use a linked correction or offset to preserve financial history.' USING ERRCODE = '42501';
    END IF;
    IF EXISTS (SELECT 1 FROM public.expenses WHERE correction_of_expense_id = OLD.id) THEN
      RAISE EXCEPTION 'An expense with linked corrections cannot be deleted.' USING ERRCODE = '42501';
    END IF;
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- A voided expense is completely frozen
    IF OLD.voided = TRUE THEN
      IF NEW.title IS DISTINCT FROM OLD.title
        OR NEW.description IS DISTINCT FROM OLD.description
        OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.split_mode IS DISTINCT FROM OLD.split_mode
        OR NEW.paid_by_member_id IS DISTINCT FROM OLD.paid_by_member_id
        OR NEW.members IS DISTINCT FROM OLD.members
        OR NEW.shares IS DISTINCT FROM OLD.shares
        OR NEW.settled IS DISTINCT FROM OLD.settled
        OR NEW.voided IS DISTINCT FROM OLD.voided
        OR NEW.void_reason IS DISTINCT FROM OLD.void_reason THEN
        RAISE EXCEPTION 'A voided expense is immutable.' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Voiding an unsettled expense transition check
    IF NEW.voided = TRUE AND OLD.voided = FALSE THEN
      v_is_settled := OLD.settled OR EXISTS (
        SELECT 1 FROM jsonb_array_elements(OLD.shares) s
        WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
          OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
      );
      IF v_is_settled THEN
        RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
      END IF;
    END IF;

    -- Settled expenses cannot have their financial facts mutated in place
    v_is_settled := OLD.settled OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(OLD.shares) s
      WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
        OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
    );
    IF v_is_settled AND NEW.voided = FALSE THEN
      IF NEW.total_amount IS DISTINCT FROM OLD.total_amount
        OR NEW.split_mode IS DISTINCT FROM OLD.split_mode
        OR NEW.paid_by_member_id IS DISTINCT FROM OLD.paid_by_member_id
        OR NEW.members IS DISTINCT FROM OLD.members
        OR NEW.currency IS DISTINCT FROM OLD.currency
        OR NEW.settlement_asset IS DISTINCT FROM OLD.settlement_asset THEN
        RAISE EXCEPTION 'Settled expenses cannot be mutated in place; create a linked correction instead.' USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_prevent_destructive_expense_ops ON public.expenses;
CREATE TRIGGER trg_prevent_destructive_expense_ops
  BEFORE UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.prevent_destructive_expense_operations();

-- 6. Freeze audit events table as append-only
CREATE OR REPLACE FUNCTION public.freeze_expense_audit_events()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'Expense audit events are append-only.' USING ERRCODE = '42501';
END;
$fn$;

DROP TRIGGER IF EXISTS trg_expense_audit_events_freeze ON public.expense_audit_events;
CREATE TRIGGER trg_expense_audit_events_freeze
  BEFORE UPDATE OR DELETE ON public.expense_audit_events
  FOR EACH ROW EXECUTE FUNCTION public.freeze_expense_audit_events();

-- 7. Trigger to automatically record audit events on void or correction creation
CREATE OR REPLACE FUNCTION public.record_expense_correction_audit_event()
RETURNS TRIGGER LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.voided = TRUE AND OLD.voided = FALSE THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (
      NEW.id,
      'voided',
      NEW.voided_by_wallet,
      NEW.void_reason,
      jsonb_build_object('total_amount', NEW.total_amount, 'voided_at', NEW.voided_at)
    );
  ELSIF TG_OP = 'INSERT' AND NEW.correction_of_expense_id IS NOT NULL THEN
    INSERT INTO public.expense_audit_events (expense_id, action, actor_wallet, reason, metadata)
    VALUES (
      NEW.id,
      CASE WHEN NEW.correction_type = 'reversal' THEN 'reversal_created' ELSE 'adjustment_created' END,
      NEW.created_by_wallet,
      NEW.correction_reason,
      jsonb_build_object(
        'correction_of_expense_id', NEW.correction_of_expense_id,
        'correction_type', NEW.correction_type,
        'total_amount', NEW.total_amount
      )
    );
  END IF;
  RETURN NEW;
END;
$fn$;

DROP TRIGGER IF EXISTS trg_expense_correction_audit ON public.expenses;
CREATE TRIGGER trg_expense_correction_audit
  AFTER INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.record_expense_correction_audit_event();

-- 8. Atomic void_expense RPC function
CREATE OR REPLACE FUNCTION public.void_expense(p_expense_id UUID, p_reason TEXT)
RETURNS public.expenses LANGUAGE plpgsql SECURITY INVOKER AS $fn$
DECLARE
  v_expense public.expenses%ROWTYPE;
  v_caller TEXT;
  v_trimmed_reason TEXT;
  v_is_settled BOOLEAN;
  v_is_authorized BOOLEAN;
BEGIN
  v_trimmed_reason := btrim(COALESCE(p_reason, ''));
  IF char_length(v_trimmed_reason) < 1 OR char_length(v_trimmed_reason) > 1000 THEN
    RAISE EXCEPTION 'A void reason between 1 and 1000 characters is required.' USING ERRCODE = '22023';
  END IF;

  v_caller := public.current_wallet();
  IF v_caller IS NULL OR v_caller = '' THEN
    RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_expense FROM public.expenses WHERE id = p_expense_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Expense not found.' USING ERRCODE = 'P0002';
  END IF;

  IF v_expense.voided THEN
    RAISE EXCEPTION 'Expense is already voided.' USING ERRCODE = '42501';
  END IF;

  -- Check permissions: caller is creator, payer, or has expenses.manage permission
  v_is_authorized := (
    upper(v_expense.created_by_wallet) = upper(v_caller)
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_expense.members) m
      WHERE m->>'id' = v_expense.paid_by_member_id AND upper(m->>'walletAddress') = upper(v_caller)
    )
    OR public.expense_has_permission(p_expense_id, 'expenses.manage')
  );
  IF NOT v_is_authorized THEN
    RAISE EXCEPTION 'You are not authorized to void this expense.' USING ERRCODE = '42501';
  END IF;

  -- Check settled status
  v_is_settled := v_expense.settled OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_expense.shares) s
    WHERE COALESCE((s->>'paid')::BOOLEAN, FALSE) = TRUE
      OR (s->'installments' IS NOT NULL AND jsonb_array_length(s->'installments') > 0)
  );
  IF v_is_settled THEN
    RAISE EXCEPTION 'A settled or partially paid expense cannot be voided; use a linked correction instead.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.expenses
  SET voided = TRUE,
      voided_at = NOW(),
      voided_by_wallet = v_caller,
      void_reason = v_trimmed_reason,
      updated_at = NOW()
  WHERE id = p_expense_id
  RETURNING * INTO v_expense;

  RETURN v_expense;
END;
$fn$;

-- 9. Row level security and permissions
ALTER TABLE public.expense_audit_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS expense_audit_events_select_members ON public.expense_audit_events;
CREATE POLICY expense_audit_events_select_members ON public.expense_audit_events
  FOR SELECT TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.expenses e
      WHERE e.id = expense_id
        AND (public.current_wallet() = ANY(e.member_wallets) OR upper(e.created_by_wallet) = upper(public.current_wallet()))
    )
  );

DROP POLICY IF EXISTS expense_audit_events_insert_system ON public.expense_audit_events;
CREATE POLICY expense_audit_events_insert_system ON public.expense_audit_events
  FOR INSERT TO authenticated
  WITH CHECK (upper(actor_wallet) = upper(public.current_wallet()));

GRANT SELECT, INSERT ON public.expense_audit_events TO authenticated;
GRANT EXECUTE ON FUNCTION public.void_expense(UUID, TEXT) TO authenticated;
REVOKE ALL ON FUNCTION public.prevent_destructive_expense_operations() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.freeze_expense_audit_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_expense_correction_audit_event() FROM PUBLIC;

NOTIFY pgrst, 'reload schema';

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0019', '0019_expense_corrections_and_voids', 'expense_corrections_and_voids_v1')
ON CONFLICT (version) DO NOTHING;


-- ============================================================================
-- Cumulative Addition from 0012_security_review_hardening.sql
-- ============================================================================

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


-- ============================================================================
-- Cumulative Addition from 0020_onchain_reconciliation_worker.sql
-- ============================================================================

-- ============================================================================
-- Migration 0020: Automated On-Chain Reconciliation Worker (#313)
-- ============================================================================
-- 1. Creates public.reconciliation_queue to durably track and resolve pending
--    settlement payments across the 4 core states:
--    - 'not_submitted'
--    - 'submitted_not_confirmed'
--    - 'confirmed_not_recorded'
--    - 'recorded'
--    plus 'escalated' (for ambiguous payments requiring operator review)
--    and 'failed' (for terminal errors / expired intents).
-- 2. Enforces backoff scheduling, retry limits, and anti-ambiguity escalation.
-- 3. Enables RLS and performance indexes for polling and operator reporting.

CREATE TABLE IF NOT EXISTS public.reconciliation_queue (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  intent_id           UUID REFERENCES public.settlement_intents(id) ON DELETE SET NULL,
  trip_id             TEXT NOT NULL,
  expense_id          TEXT NOT NULL,
  member_id           TEXT NOT NULL,
  payer_wallet        TEXT NOT NULL,
  member_wallet       TEXT NOT NULL,
  asset               TEXT NOT NULL DEFAULT 'XLM',
  amount              TEXT NOT NULL,
  amount_stroops      NUMERIC(30) NOT NULL,
  expected_memo       TEXT,
  request_id          TEXT,
  tx_hash             TEXT,
  ledger              BIGINT,
  status              TEXT NOT NULL DEFAULT 'not_submitted'
                      CHECK (status IN (
                        'not_submitted',
                        'submitted_not_confirmed',
                        'confirmed_not_recorded',
                        'recorded',
                        'escalated',
                        'failed'
                      )),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 10,
  backoff_ms          INT NOT NULL DEFAULT 5000,
  last_attempt_at     TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  escalation_reason   TEXT,
  error_message       TEXT,
  verified_at         TIMESTAMPTZ,
  recorded_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for polling due jobs fast
CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_status_next_attempt
  ON public.reconciliation_queue (status, next_attempt_at);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_tx_hash
  ON public.reconciliation_queue (tx_hash);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_intent_id
  ON public.reconciliation_queue (intent_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_trip_expense
  ON public.reconciliation_queue (trip_id, expense_id);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_parties
  ON public.reconciliation_queue (member_wallet, payer_wallet);

CREATE INDEX IF NOT EXISTS idx_reconciliation_queue_created_at
  ON public.reconciliation_queue (created_at DESC);

-- Trigger to maintain updated_at
DROP TRIGGER IF EXISTS trg_reconciliation_queue_updated_at ON public.reconciliation_queue;
CREATE TRIGGER trg_reconciliation_queue_updated_at
  BEFORE UPDATE ON public.reconciliation_queue
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS
ALTER TABLE public.reconciliation_queue ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS reconciliation_queue_select_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_select_parties ON public.reconciliation_queue
  FOR SELECT TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS reconciliation_queue_insert_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_insert_parties ON public.reconciliation_queue
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

DROP POLICY IF EXISTS reconciliation_queue_update_parties ON public.reconciliation_queue;
CREATE POLICY reconciliation_queue_update_parties ON public.reconciliation_queue
  FOR UPDATE TO authenticated
  USING (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  )
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND public.current_wallet() IN (member_wallet, payer_wallet)
  );

GRANT SELECT, INSERT, UPDATE ON public.reconciliation_queue TO authenticated;

-- Record migration
INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0020', '0020_onchain_reconciliation_worker', 'onchain_reconciliation_worker_313_v1')
ON CONFLICT (version) DO NOTHING;
