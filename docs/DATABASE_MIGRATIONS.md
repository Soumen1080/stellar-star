# Stellar-star Database Migrations Guide

This guide describes how database schema migrations are authored, tracked, applied, verified, and rolled back in Stellar-star.

---

## 1. Architecture Overview

Stellar-star uses an **ordered, versioned, idempotent migration pipeline**:

```
migrations/
  ├── 0001_baseline.sql                    # Initial idempotent schema & tables
  ├── 0002_explicit_trigger_pipeline.sql   # Deterministic trigger execution order
  └── ...
```

### The `schema_migrations` Table

All applied migrations are recorded in PostgreSQL in `public.schema_migrations`:

```sql
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version     TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  checksum    TEXT NOT NULL
);
```

- **`version`**: Unique numeric identifier (e.g. `0001`, `0002`).
- **`name`**: Migration filename without extension.
- **`checksum`**: SHA-256 digest of migration file contents to detect conflicts or uncoordinated edits between parallel branches.
- **`applied_at`**: Timestamp when the migration was applied.

---

## 2. Developer Workflow: Adding a Migration

When adding columns, tables, or altering RLS policies:

1. **Create a new migration file** in `migrations/` with a sequential prefix:
   ```bash
   migrations/0003_add_asset_and_fx_rates.sql
   ```
2. **Follow Zero-Downtime Expand-and-Contract Principles**:
   - Never add a `NOT NULL` column without a `DEFAULT` in a single step on a live table.
   - When renaming or splitting columns, add the new column first (expand), backfill, update application code, and drop the old column in a later release (contract).
   - Use `IF NOT EXISTS` / `IF EXISTS` where appropriate.
3. **Register the migration** at the end of the file:
   ```sql
   INSERT INTO public.schema_migrations (version, name, checksum)
   VALUES ('0003', '0003_add_asset_and_fx_rates', '<checksum>')
   ON CONFLICT (version) DO NOTHING;
   ```
4. **Update `supabase-setup.sql`** so that the single-file developer setup remains in sync with all cumulative migrations.

---

## 3. Verification & CLI Commands

Check migration status and database schema agreement:

```bash
# View migration status (applied vs pending)
npm run db:status

# Apply pending migrations
npm run db:migrate

# Comprehensive end-to-end database & schema check
npm run db:check
```

In CI/CD, `npm run db:check` fails the build if the database schema is missing any migrations that exist in the codebase.

---

## 4. Trigger Execution Pipeline

PostgreSQL executes multiple triggers of the same event and timing class (`BEFORE UPDATE`) in **alphabetical order of trigger names**.

To prevent load-bearing behavior from relying on accidental naming coincidences, all triggers use explicit numeric prefixes:

1. **`trg_01_expenses_freeze_identity`**: Enforces immutability of `id`, `created_at`, and `created_by_wallet`.
2. **`trg_02_expenses_sync_member_wallets`**: Derives `member_wallets` access array from the verified creator and members JSONB.
3. **`trg_03_expenses_validate_shares`**: Enforces $\sum shares == total\_amount$.
4. **`trg_04_expenses_set_updated_at`**: Stamps `updated_at := NOW()`.

This pipeline is continuously asserted by `__tests__/database/triggerOrder.test.ts`.

---

## 5. Rollback Procedures

### Forward-Compatible Rollbacks (Recommended)
In continuous deployment environments with live users, database rollbacks should be **forward-compatible migrations** (e.g. `0004_revert_feature_x.sql`) rather than destructive `DOWN` scripts that can drop in-flight data.

### Manual Emergency Reversion
If an emergency reversion of a specific migration is required in staging/development:
1. Revert the DDL operations manually in the Supabase SQL Editor.
2. Remove the migration version from `schema_migrations`:
   ```sql
   DELETE FROM public.schema_migrations WHERE version = '0002';
   ```
3. Run `npm run db:check` to verify consistency.

## 8. Schema drift between the two provisioning paths

There are two ways a database gets created:

1. An operator pastes `supabase-setup.sql` into the Supabase SQL Editor.
2. The migrations in `migrations/*.sql` are applied in order.

**Both must produce the same schema.** When they diverge, the version number
stops meaning anything: a database can report `0002` and still be missing
functions the application calls.

This is not hypothetical. Commits `0823a9e` and `dad56b6` added auth challenge
storage, auth rate limiting, trip invites and the optimistic-concurrency RPCs
directly to `supabase-setup.sql` with no accompanying migration. A database
provisioned by running migrations was missing RPCs that authentication and
expense editing call at runtime — and nothing failed until they were called.
`migrations/0003_reconcile_drifted_schema.sql` carried those objects into the
versioned track.

### The rule

> Any change to `supabase-setup.sql` requires a matching migration, and any new
> migration requires the same objects in `supabase-setup.sql`.

`__tests__/database/schemaDrift.test.ts` enforces this statically in CI: it
extracts every table, function and index from both paths and fails if either
side has an object the other lacks. It runs on every PR, so drift is caught
before deployment rather than at runtime.

It deliberately ignores policies and triggers — the setup file drops and
recreates those wholesale, so their text legitimately differs. Trigger
execution order has its own test (`triggerOrder.test.ts`).

### Adding a migration

1. Add the objects to `supabase-setup.sql`.
2. Create `migrations/000N_description.sql` with the same objects, written
   idempotently (`IF NOT EXISTS`, `CREATE OR REPLACE`, `DROP POLICY IF EXISTS`
   before `CREATE POLICY`).
3. End it with the tracking insert, using `ON CONFLICT (version) DO NOTHING`.
4. Run `npm test -- schemaDrift` to confirm the two paths still agree.

Two contributors both claiming `0004` produce a filename collision in git
rather than a silent divergence — which is the point.
