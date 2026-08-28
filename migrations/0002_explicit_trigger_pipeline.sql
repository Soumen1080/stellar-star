-- ============================================================================
-- Stellar-star Migration 0002: Explicit Trigger Pipeline
-- ============================================================================
-- Replaces legacy trigger names with an explicitly ordered trigger pipeline.
--
-- Postgres executes triggers within the same timing class (BEFORE UPDATE) in
-- alphabetical order of trigger names. This migration assigns deterministic
-- numerical prefixes (trg_01_*, trg_02_*, trg_03_*, trg_04_*) to guarantee
-- that:
--   1. trg_01_*_freeze_identity restores OLD.created_by_wallet and OLD.id
--   2. trg_02_*_sync_member_wallets computes member_wallets from the verified creator
--   3. trg_03_*_validate_shares verifies sum(shares) == total_amount
--   4. trg_04_*_set_updated_at stamps updated_at := NOW()

-- ─── 1. DROP LEGACY TRIGGERS ──────────────────────────────────────────────────

DROP TRIGGER IF EXISTS users_set_updated_at         ON public.users;
DROP TRIGGER IF EXISTS expenses_set_updated_at      ON public.expenses;
DROP TRIGGER IF EXISTS trips_set_updated_at         ON public.trips;
DROP TRIGGER IF EXISTS expenses_sync_member_wallets ON public.expenses;
DROP TRIGGER IF EXISTS trips_sync_member_wallets    ON public.trips;
DROP TRIGGER IF EXISTS expenses_freeze_identity     ON public.expenses;
DROP TRIGGER IF EXISTS trips_freeze_identity        ON public.trips;
DROP TRIGGER IF EXISTS expenses_validate_shares     ON public.expenses;

-- ─── 2. CREATE ORDERED TRIGGERS ──────────────────────────────────────────────

-- Users
DROP TRIGGER IF EXISTS trg_01_users_set_updated_at ON public.users;
CREATE TRIGGER trg_01_users_set_updated_at
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Expenses Pipeline:
-- 1. Freeze identity -> 2. Sync member wallets -> 3. Validate shares -> 4. Set updated_at
DROP TRIGGER IF EXISTS trg_01_expenses_freeze_identity ON public.expenses;
CREATE TRIGGER trg_01_expenses_freeze_identity
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

DROP TRIGGER IF EXISTS trg_02_expenses_sync_member_wallets ON public.expenses;
CREATE TRIGGER trg_02_expenses_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

DROP TRIGGER IF EXISTS trg_03_expenses_validate_shares ON public.expenses;
CREATE TRIGGER trg_03_expenses_validate_shares
  BEFORE INSERT OR UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.validate_expense_shares();

DROP TRIGGER IF EXISTS trg_04_expenses_set_updated_at ON public.expenses;
CREATE TRIGGER trg_04_expenses_set_updated_at
  BEFORE UPDATE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Trips Pipeline:
-- 1. Freeze identity -> 2. Sync member wallets -> 3. Set updated_at
DROP TRIGGER IF EXISTS trg_01_trips_freeze_identity ON public.trips;
CREATE TRIGGER trg_01_trips_freeze_identity
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.freeze_row_identity();

DROP TRIGGER IF EXISTS trg_02_trips_sync_member_wallets ON public.trips;
CREATE TRIGGER trg_02_trips_sync_member_wallets
  BEFORE INSERT OR UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.sync_member_wallets();

DROP TRIGGER IF EXISTS trg_03_trips_set_updated_at ON public.trips;
CREATE TRIGGER trg_03_trips_set_updated_at
  BEFORE UPDATE ON public.trips
  FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- ─── 3. RECORD MIGRATION ─────────────────────────────────────────────────────

INSERT INTO public.schema_migrations (version, name, checksum)
VALUES ('0002', '0002_explicit_trigger_pipeline', 'trigger_pipeline_checksum')
ON CONFLICT (version) DO NOTHING;
