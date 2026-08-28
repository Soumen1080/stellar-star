# Design Note: Versioned Database Migration Story & Deterministic Trigger Pipeline

Issue #159 (epic #53).

## The problem

Previously, Stellar-star lacked a migrations directory and schema tracking mechanism:
- **Imperative Monolith**: `supabase-setup.sql` was a single 423-line SQL file pasted into the Supabase SQL Editor. It mixed table creation, `DO $migrate$` blocks, triggers, RLS policies, and realtime publications.
- **Zero Schema Visibility**: There was no record of what version a database was at. A deployment could be missing columns or triggers with no way to detect discrepancies before runtime crashes.
- **Merge Conflicts Between Contributors**: Two engineers adding database fields on parallel branches had no structured mechanism to sequence their changes.
- **Fragile Trigger Firing Order**: PostgreSQL executes triggers within the same timing class (`BEFORE UPDATE`) alphabetically by name. The app relied on `expenses_freeze_identity` running before `expenses_sync_member_wallets` so that forged creator identities were reverted before `member_wallets` was computed. This critical security invariant rested on an undocumented naming coincidence.

## The approach taken

We introduced a **Versioned Idempotent Migration Engine**, a **`schema_migrations` Tracking Table**, and an **Explicitly Numbered Trigger Pipeline**.

```
migrations/
  ├── 0001_baseline.sql                  --> public.schema_migrations (0001)
  └── 0002_explicit_trigger_pipeline.sql --> public.schema_migrations (0002)

CLI / CI:
  npm run db:check   ---> Validates all migrations are applied
  npm run db:migrate ---> Runs migration runner (scripts/migrate.mjs)
  npm run db:status  ---> Displays migration ledger & checksum verification
```

### 1. Unified Migration Ledger (`public.schema_migrations`)

We introduced the `public.schema_migrations` table:
- `version` (e.g. `0001`, `0002`): Primary key enforcing strict sequential ordering.
- `name`: Full migration filename.
- `checksum`: SHA-256 hash of the migration script, preventing uncoordinated edits on already-applied migrations.
- `applied_at`: Timestamp recording when the migration executed.

### 2. Idempotent Baseline (`0001_baseline.sql`)

Existing production databases were provisioned by pasting older versions of `supabase-setup.sql`.
To satisfy **Invariant 1** (existing databases converge to the same schema as fresh databases with zero data loss):
- `0001_baseline.sql` contains `IF NOT EXISTS` / `IF EXISTS` DDL and a `DO $migrate$` block that updates existing databases in-place without dropping data.
- Registers itself in `schema_migrations` via `ON CONFLICT (version) DO NOTHING`.

### 3. Explicit Ordered Trigger Pipeline (`0002_explicit_trigger_pipeline.sql`)

To satisfy **Invariant 4** (trigger execution order is explicit and asserted by a test):
- Triggers are assigned deterministic numeric prefixes:
  - `trg_01_expenses_freeze_identity`
  - `trg_02_expenses_sync_member_wallets`
  - `trg_03_expenses_validate_shares`
  - `trg_04_expenses_set_updated_at`
- Guarantees PostgreSQL alphabetical ordering so `freeze_row_identity` always executes before `sync_member_wallets`.

### 4. Verification in `npm run db:check` & `scripts/migrate.mjs`

- `npm run db:check` reads local `migrations/*.sql`, queries `schema_migrations` on the remote database, and fails if any migration is unapplied (**Invariant 3**).
- `scripts/migrate.mjs` provides `--status`, `--check`, and automated migration application.

## Alternatives considered and rejected

### Alternative A: Heavy Third-Party Migration Frameworks (Prisma / Flyway / Knex)
Using Prisma Migrate or Knex migrations.
- **Why rejected**: Introduces heavy Node dependencies and database binary engines into a lightweight Next.js + Supabase application. Furthermore, Supabase provides Postgres RLS policies, custom PL/pgSQL functions, and triggers that ORM abstraction layers struggle to represent cleanly without raw SQL files.

### Alternative B: Purely Imperative Single-File Schema
Continuing to append `ALTER TABLE` statements to `supabase-setup.sql`.
- **Why rejected**: Fails Invariants 2, 3, and 5. There is no historical ledger of what ran, no way for CI to verify database version matches code before runtime, and concurrent feature branches corrupt the single file.

## Invariant Verification

| Invariant | Mechanism |
|---|---|
| **1. Fresh & Existing Convergence** | Idempotent baseline with `IF NOT EXISTS` converges fresh and legacy databases without data loss. |
| **2. Idempotent Ledger** | `public.schema_migrations` records version, name, checksum, and timestamp. |
| **3. Pre-Runtime Schema Check** | `npm run db:check` queries `schema_migrations` and alerts operators before runtime crashes. |
| **4. Explicit Trigger Execution Order** | Numbered trigger prefixes (`trg_01_*` -> `trg_04_*`) asserted by `__tests__/database/triggerOrder.test.ts`. |
| **5. Parallel Branch Conflict Prevention** | Migration filenames are sequentially versioned and checksummed, detecting parallel conflicts in CI. |

## Residual Weaknesses, Stated Plainly

- **Manual Execution via SQL Editor when Direct DDL API is Restricted**: In serverless Supabase environments without direct raw SQL RPC privileges for anon keys, operators apply migrations via `supabase-setup.sql` or Supabase SQL Editor. `npm run db:check` verifies and alerts whenever a migration is pending.

## Test Coverage

- `__tests__/database/triggerOrder.test.ts`:
  - Asserts DDL trigger naming alphabetical ordering matches `trg_01` -> `trg_04`.
  - Asserts `supabase-setup.sql` matches migration trigger definitions.
  - Simulates the multi-stage trigger pipeline: verifies that reversing `freeze_identity` and `sync_member_wallets` would allow a forged creator to leak into `member_wallets`.
