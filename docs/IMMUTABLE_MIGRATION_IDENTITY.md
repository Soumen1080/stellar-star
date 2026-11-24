# Immutable Migration Identity and Deterministic Ledger

This document describes the design, operational guarantees, and validation mechanisms for immutable database migration identities and deterministic sequence enforcement in Stellar-star.

---

## 1. Problem Statement

Historically, database migrations in the repository relied exclusively on numeric version prefixes (e.g. `0001`, `0005`, `0019`). Over the project's evolution, multiple parallel feature branches introduced identical prefixes:

- `0005`: `0005_auth_challenge_storage.sql` and `0005_fix_category_icons.sql`
- `0007`: `0007_composite_query_indexes.sql` and `0007_reconcile_receipt_columns.sql`
- `0008`: `0008_contact_aliases.sql` and `0008_idempotent_settlement_intents.sql`
- `0009`: `0009_auth_rate_limits.sql` and `0009_expense_receipts.sql`
- `0010`: `0010_trip_invites.sql` and `0010_payment_request_metadata.sql`
- `0011`: `0011_reconcile_schema_drift.sql` and `0011_receipt_metadata.sql`
- `0012`: `0012_recurring_expenses.sql` and `0012_disputes.sql`
- `0013`: `0013_partial_settlement.sql` and `0013_receipt_content_type_allowlist.sql`
- `0014`: `0014_support_dual_control.sql` and `0014_receipt_storage_private.sql`
- `0018`: `0018_receipt_ocr_indexes.sql` and `0018_settlement_oracle_quorum.sql`
- `0019`: `0019_receipt_ocr_cache.sql` and `0019_shared_household_coordination.sql`

### Risks of Duplicate Numeric Prefixes
1. **Filename-Dependent Ordering**: Migration discovery via filesystem directory listing (`fs.readdirSync`) sorted files purely alphabetically by suffix characters after the prefix. Different platforms, filesystems, or locale sort collations could yield non-deterministic migration application orders across environments.
2. **Silent Skipping in Database Ledger**: In the legacy database ledger `public.schema_migrations`, the primary key was `version TEXT`. When a migration completed with:
   ```sql
   INSERT INTO public.schema_migrations (version, name, checksum)
   VALUES ('0005', '0005_fix_category_icons', '...')
   ON CONFLICT (version) DO NOTHING;
   ```
   If `0005_auth_challenge_storage.sql` had already run and populated the `'0005'` row, the conflict clause caused PostgreSQL to silently skip recording `0005_fix_category_icons`.
3. **History Mutability**: Files could theoretically be reordered, modified, or inserted into historical sequences without automated detection.

In production, database schema history is an **append-only operational record**, not a loose collection of files.

---

## 2. Architecture of Immutable Migration Identity

To guarantee deterministic ordering and tamper-evident history, Stellar-star establishes three foundational pillars:

```
┌─────────────────────────────────┐
│     migrations/manifest.json     │  Canonical, append-only manifest
│ (Strict Sequence 1..N, SHA-256) │
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│       scripts/migrate.mjs       │  Validates manifest & checksums;
│  npm run db:manifest:verify     │  Applies migrations in exact order
└───────────────┬─────────────────┘
                │
                ▼
┌─────────────────────────────────┐
│    public.schema_migrations     │  Database Ledger with migration_id,
│   public.record_migration_v2    │  sequence, manifest_checksum, name
└─────────────────────────────────┘
```

### 2.1 Canonical Manifest (`migrations/manifest.json`)
The manifest acts as the source of truth for migration sequencing and immutability:
- **`formatVersion`**: Manifest specification format version (`"1.0.0"`).
- **`sequence`**: Strict continuous integers `1, 2, 3, ..., N` with zero gaps or reordering.
- **`id`**: Unique, immutable identifier string for every migration (e.g., `0005_auth_challenge_storage`, `0005_fix_category_icons`).
- **`sha256`**: Full 64-character SHA-256 cryptographic digest of the exact file content.
- **`checksum`**: 16-character cryptographic prefix used for rapid verification.
- **`filename` & `name`**: Exact on-disk filenames.
- **`description`**: Semantic purpose of the migration.

### 2.2 Hardened Database Ledger (`public.schema_migrations`)
Migration `0021_immutable_migration_identity.sql` alters `public.schema_migrations` to add:
```sql
ALTER TABLE public.schema_migrations
  ADD COLUMN IF NOT EXISTS migration_id TEXT,
  ADD COLUMN IF NOT EXISTS sequence INT,
  ADD COLUMN IF NOT EXISTS manifest_checksum TEXT;

CREATE INDEX IF NOT EXISTS idx_schema_migrations_name
  ON public.schema_migrations (name);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_sequence
  ON public.schema_migrations (sequence);
CREATE INDEX IF NOT EXISTS idx_schema_migrations_migration_id
  ON public.schema_migrations (migration_id);
```

### 2.3 Idempotent Registration Procedure (`public.record_migration_v2`)
To avoid version-collision skipping, `public.record_migration_v2` registers migrations by their unique `migration_id`:
```sql
CREATE OR REPLACE FUNCTION public.record_migration_v2(
  p_version TEXT,
  p_name TEXT,
  p_migration_id TEXT,
  p_sequence INT,
  p_manifest_checksum TEXT
) RETURNS VOID AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.schema_migrations WHERE migration_id = p_migration_id) THEN
    UPDATE public.schema_migrations
    SET name = p_name,
        sequence = p_sequence,
        manifest_checksum = p_manifest_checksum
    WHERE migration_id = p_migration_id;
  ELSIF EXISTS (SELECT 1 FROM public.schema_migrations WHERE version = p_version AND migration_id IS NULL) THEN
    UPDATE public.schema_migrations
    SET migration_id = p_migration_id,
        name = p_name,
        sequence = p_sequence,
        manifest_checksum = p_manifest_checksum
    WHERE version = p_version AND migration_id IS NULL;
  ELSE
    INSERT INTO public.schema_migrations (version, name, migration_id, sequence, manifest_checksum)
    VALUES (p_version, p_name, p_migration_id, p_sequence, p_manifest_checksum)
    ON CONFLICT (version) DO UPDATE
      SET migration_id = EXCLUDED.migration_id,
          sequence = EXCLUDED.sequence,
          manifest_checksum = EXCLUDED.manifest_checksum;
  END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## 3. Backfill of Historical Migrations

Migration `0021_immutable_migration_identity.sql` deterministically backfills all 32 prior migrations (sequences 1 through 32) and self-registers as sequence 33:

| Sequence | Migration ID | Version | Filename |
|---|---|---|---|
| 1 | `0001_baseline` | `0001` | `0001_baseline.sql` |
| 2 | `0002_explicit_trigger_pipeline` | `0002` | `0002_explicit_trigger_pipeline.sql` |
| 3 | `0003_reconcile_drifted_schema` | `0003` | `0003_reconcile_drifted_schema.sql` |
| 4 | `0004_drop_reconciled_duplicate_rpcs` | `0004` | `0004_drop_reconciled_duplicate_rpcs.sql` |
| 5 | `0005_auth_challenge_storage` | `0005` | `0005_auth_challenge_storage.sql` |
| 6 | `0005_fix_category_icons` | `0005` | `0005_fix_category_icons.sql` |
| 7 | `0006_contacts_and_aliases` | `0006` | `0006_contacts_and_aliases.sql` |
| 8 | `0007_composite_query_indexes` | `0007` | `0007_composite_query_indexes.sql` |
| 9 | `0007_reconcile_receipt_columns` | `0007` | `0007_reconcile_receipt_columns.sql` |
| 10 | `0008_contact_aliases` | `0008` | `0008_contact_aliases.sql` |
| 11 | `0008_idempotent_settlement_intents` | `0008` | `0008_idempotent_settlement_intents.sql` |
| 12 | `0009_auth_rate_limits` | `0009` | `0009_auth_rate_limits.sql` |
| 13 | `0009_expense_receipts` | `0009` | `0009_expense_receipts.sql` |
| 14 | `0010_payment_request_metadata` | `0010` | `0010_payment_request_metadata.sql` |
| 15 | `0010_trip_invites` | `0010` | `0010_trip_invites.sql` |
| 16 | `0011_receipt_metadata` | `0011` | `0011_receipt_metadata.sql` |
| 17 | `0011_reconcile_schema_drift` | `0011` | `0011_reconcile_schema_drift.sql` |
| 18 | `0012_disputes` | `0012` | `0012_disputes.sql` |
| 19 | `0012_recurring_expenses` | `0012` | `0012_recurring_expenses.sql` |
| 20 | `0013_partial_settlement` | `0013` | `0013_partial_settlement.sql` |
| 21 | `0013_receipt_content_type_allowlist` | `0013` | `0013_receipt_content_type_allowlist.sql` |
| 22 | `0014_receipt_storage_private` | `0014` | `0014_receipt_storage_private.sql` |
| 23 | `0014_support_dual_control` | `0014` | `0014_support_dual_control.sql` |
| 24 | `0015_trip_templates` | `0015` | `0015_trip_templates.sql` |
| 25 | `0016_trip_roles_and_permissions` | `0016` | `0016_trip_roles_and_permissions.sql` |
| 26 | `0017_trip_budgets` | `0017` | `0017_trip_budgets.sql` |
| 27 | `0018_receipt_ocr_indexes` | `0018` | `0018_receipt_ocr_indexes.sql` |
| 28 | `0018_settlement_oracle_quorum` | `0018` | `0018_settlement_oracle_quorum.sql` |
| 29 | `0019_receipt_ocr_cache` | `0019` | `0019_receipt_ocr_cache.sql` |
| 30 | `0019_shared_household_coordination` | `0019` | `0019_shared_household_coordination.sql` |
| 31 | `0020_expense_history_search` | `0020` | `0020_expense_history_search.sql` |
| 32 | `0020_transaction_concurrency_guards` | `0020` | `0020_transaction_concurrency_guards.sql` |
| 33 | `0021_immutable_migration_identity` | `0021` | `0021_immutable_migration_identity.sql` |

---

## 4. Verification & Testing

### 4.1 CLI Verification
Verify the entire manifest against files on disk:
```bash
npm run db:manifest:verify
```
The command enforces:
1. Manifest parses valid JSON and conforms to `formatVersion: "1.0.0"`.
2. Sequence numbers are consecutive integers starting at 1 with no gaps.
3. Every migration ID is non-empty and unique.
4. Every filename listed exists on disk.
5. Every `.sql` file in `migrations/` is tracked in the manifest (zero untracked migrations).
6. The SHA-256 digest of every file matches the manifest exactly.

### 4.2 Automated Test Suite (`__tests__/database/immutableMigrationIdentity.test.ts`)
The Jest test suite enforces:
- Manifest integrity and schema structure.
- Prevention of duplicate IDs or ambiguous prefixes.
- Cryptographic checksum matching for all migrations.
- Ledger DDL consistency across `0021_immutable_migration_identity.sql` and `supabase-setup.sql`.
- Disambiguation verification for historical duplicate numeric prefixes.

### 4.3 Schema Drift Invariant
Both provisioning paths:
1. Executing `supabase-setup.sql` on a fresh Supabase database.
2. Applying migrations `0001` through `0021` in sequence order on an existing database.

Produce **identically equivalent** database objects:
- Tables: 0 missing, 0 extra.
- Functions: 0 missing, 0 extra.
- Indexes: 0 missing, 0 extra.

---

## 5. Developer Guide: Authoring a New Migration

When contributing a new migration:
1. Create the new SQL file with a sequential prefix: `migrations/0022_<feature_name>.sql`.
2. Author idempotent DDL (`IF NOT EXISTS`, `CREATE OR REPLACE`).
3. Self-register the migration in `schema_migrations` and invoke `record_migration_v2`:
   ```sql
   SELECT public.record_migration_v2(
     '0022',
     '0022_<feature_name>',
     '0022_<feature_name>',
     34,
     '<16_char_checksum>'
   );

   INSERT INTO public.schema_migrations (version, name, migration_id, sequence, manifest_checksum)
   VALUES ('0022', '0022_<feature_name>', '0022_<feature_name>', 34, '<16_char_checksum>')
   ON CONFLICT (version) DO NOTHING;
   ```
4. Append corresponding durable DDL to `supabase-setup.sql`.
5. Add an entry to `migrations/manifest.json` with the next sequence number (e.g. 34), unique ID, filename, SHA-256, and checksum prefix.
6. Run `npm run db:manifest:verify` and `npm test -- schemaDrift` to ensure zero drift and manifest validity.
