-- ============================================================================
-- Stellar-star Migration 0001: Baseline Schema
-- ============================================================================
-- Idempotent baseline representing the core schema, RLS, functions, triggers,
-- indexes, and migration tracking.

-- ─── 0. MIGRATION TRACKING ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL
);

ALTER TABLE public.schema_migrations ENABLE ROW LEVEL SECURITY;

CREATE POLICY schema_migrations_read ON public.schema_migrations
  FOR SELECT TO authenticated, anon USING (true);

-- ─── 1. EXTENSIONS ───────────────────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─── 2. IDENTITY HELPER ──────────────────────────────────────────────────────

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

-- ─── 3. TABLES ───────────────────────────────────────────────────────────────

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

CREATE TABLE IF NOT EXISTS public.sponsored_accounts (
  account_id   text        primary key,
  sponsor      text        not null,
  operation_id text        not null unique,
  created_at   timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.sponsorship_invites (
  id            uuid        primary key default gen_random_uuid(),
  inviter       text        not null,
  invitee       text        not null,
  created_at_ms bigint      not null,
  created_at    timestamptz not null default now(),
  constraint sponsorship_invites_pair_unique unique (inviter, invitee)
);

CREATE TABLE IF NOT EXISTS public.auth_challenges (
  nonce       text        primary key,
  address     text        not null,
  expiration  bigint      not null,
  created_at  timestamptz not null default now()
);

CREATE TABLE IF NOT EXISTS public.auth_rate_limits (
  key           text        primary key,
  count         integer     not null default 1,
  window_start  bigint      not null,
  updated_at    timestamptz not null default now()
);

-- ─── 4. MIGRATE PRE-EXISTING INSTALLS ────────────────────────────────────────

DO $migrate$
BEGIN
  -- users
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

  -- expenses / trips wallet columns
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

-- ─── 5. INTEGRITY FUNCTIONS & TRIGGERS ────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$fn$;

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

  IF NEW.created_by_wallet IS NOT NULL
     AND NEW.created_by_wallet <> ''
     AND NOT (NEW.created_by_wallet = ANY (wallets)) THEN
    wallets := array_prepend(NEW.created_by_wallet, wallets);
  END IF;

  NEW.member_wallets := wallets;
  RETURN NEW;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.freeze_row_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.id                := OLD.id;
  NEW.created_at        := OLD.created_at;
  NEW.created_by_wallet := OLD.created_by_wallet;
  RETURN NEW;
END;
$fn$;

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

-- Triggers
DROP TRIGGER IF EXISTS users_set_updated_at         ON public.users;
DROP TRIGGER IF EXISTS expenses_set_updated_at      ON public.expenses;
DROP TRIGGER IF EXISTS trips_set_updated_at         ON public.trips;
DROP TRIGGER IF EXISTS expenses_sync_member_wallets ON public.expenses;
DROP TRIGGER IF EXISTS trips_sync_member_wallets    ON public.trips;
DROP TRIGGER IF EXISTS expenses_freeze_identity     ON public.expenses;
DROP TRIGGER IF EXISTS trips_freeze_identity        ON public.trips;
DROP TRIGGER IF EXISTS expenses_validate_shares     ON public.expenses;

CREATE TRIGGER users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER expenses_freeze_identity
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

CREATE TRIGGER expenses_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

CREATE TRIGGER expenses_validate_shares
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_shares();

CREATE TRIGGER expenses_set_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

CREATE TRIGGER trips_freeze_identity
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

CREATE TRIGGER trips_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

CREATE TRIGGER trips_set_updated_at
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 6. INDEXES ──────────────────────────────────────────────────────────────

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

CREATE INDEX IF NOT EXISTS sponsorship_invites_inviter_idx
  ON public.sponsorship_invites (inviter, created_at_ms desc);

CREATE INDEX IF NOT EXISTS auth_challenges_address_idx ON public.auth_challenges (address);
CREATE INDEX IF NOT EXISTS auth_challenges_expiration_idx ON public.auth_challenges (expiration);
CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx ON public.auth_rate_limits (window_start);

-- ─── 7. ROW LEVEL SECURITY ───────────────────────────────────────────────────

ALTER TABLE public.users       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips       ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsored_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sponsorship_invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_challenges    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.auth_rate_limits   ENABLE ROW LEVEL SECURITY;

-- users policies
DROP POLICY IF EXISTS users_select_own ON public.users;
DROP POLICY IF EXISTS users_insert_own ON public.users;
DROP POLICY IF EXISTS users_update_own ON public.users;

CREATE POLICY users_select_own ON public.users
  FOR SELECT TO authenticated, anon USING (true);

CREATE POLICY users_insert_own ON public.users
  FOR INSERT TO authenticated
  WITH CHECK (public.current_wallet() IS NOT NULL AND wallet_address = public.current_wallet());

CREATE POLICY users_update_own ON public.users
  FOR UPDATE TO authenticated
  USING (wallet_address = public.current_wallet())
  WITH CHECK (wallet_address = public.current_wallet());

-- expenses policies
DROP POLICY IF EXISTS expenses_select_member ON public.expenses;
DROP POLICY IF EXISTS expenses_insert_member ON public.expenses;
DROP POLICY IF EXISTS expenses_update_member ON public.expenses;
DROP POLICY IF EXISTS expenses_delete_owner  ON public.expenses;

CREATE POLICY expenses_select_member ON public.expenses
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets));

CREATE POLICY expenses_insert_member ON public.expenses
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
    AND (member_wallets = ARRAY[]::TEXT[] OR public.current_wallet() = ANY (member_wallets))
  );

CREATE POLICY expenses_update_member ON public.expenses
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets))
  WITH CHECK (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets));

CREATE POLICY expenses_delete_owner ON public.expenses
  FOR DELETE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND created_by_wallet = public.current_wallet());

-- trips policies
DROP POLICY IF EXISTS trips_select_member ON public.trips;
DROP POLICY IF EXISTS trips_insert_member ON public.trips;
DROP POLICY IF EXISTS trips_update_member ON public.trips;
DROP POLICY IF EXISTS trips_delete_owner  ON public.trips;

CREATE POLICY trips_select_member ON public.trips
  FOR SELECT TO authenticated
  USING (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets));

CREATE POLICY trips_insert_member ON public.trips
  FOR INSERT TO authenticated
  WITH CHECK (
    public.current_wallet() IS NOT NULL
    AND created_by_wallet = public.current_wallet()
    AND (member_wallets = ARRAY[]::TEXT[] OR public.current_wallet() = ANY (member_wallets))
  );

CREATE POLICY trips_update_member ON public.trips
  FOR UPDATE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets))
  WITH CHECK (public.current_wallet() IS NOT NULL AND public.current_wallet() = ANY (member_wallets));

CREATE POLICY trips_delete_owner ON public.trips
  FOR DELETE TO authenticated
  USING (public.current_wallet() IS NOT NULL AND created_by_wallet = public.current_wallet());

-- ─── 8. GRANTS ───────────────────────────────────────────────────────────────

GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT ALL ON TABLE public.users TO anon, authenticated;
GRANT ALL ON TABLE public.expenses TO anon, authenticated;
GRANT ALL ON TABLE public.trips TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_wallet() TO anon, authenticated;

-- ─── 9. REALTIME PUBLICATION ─────────────────────────────────────────────────

DO $pub$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime'
  ) THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'users'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.users;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'expenses'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.expenses;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
     WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'trips'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.trips;
  END IF;
END
$pub$;

-- ─── 10. RECORD BASELINE MIGRATION ───────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0001', '0001_baseline', 'baseline_initial_checksum')
ON CONFLICT (version) DO NOTHING;
