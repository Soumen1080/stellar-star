# Database Type Generation and CI Release Gate

This document describes the architecture, verification gate, and boundary typing for PostgreSQL schema and Supabase TypeScript type synchronization in Stellar-star.

---

## 1. Problem Statement

Previously, `types/supabase.ts` was manually maintained alongside `supabase-setup.sql` and `migrations/*.sql`. Over time, manual synchronization introduces several risks:

1. **Schema Drift**: New columns or tables added to migrations may not be reflected in `types/supabase.ts`, or vice versa.
2. **Unsafe Type Casting**: Several critical RPC boundaries returned generic `Json`, forcing callers to use unsafe type assertions (e.g. `data as Record<string, unknown>` or `data as { success: boolean }`).
3. **Missing RPCs**: Functions such as `delete_user_account` and `record_migration_v2` were absent from `Database["public"]["Functions"]`.
4. **Late Failures**: Type discrepancies only surfaced as runtime exceptions in production rather than build-time failures in CI.

---

## 2. Architecture: Disposable Schema & CI Release Gate

To turn type synchronization into an automated release gate, Stellar-star uses an in-memory disposable schema pipeline:

```
┌───────────────────────────────────────┐
│ migrations/*.sql & supabase-setup.sql │
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│    Disposable In-Memory Database      │  Built in CI via @electric-sql/pglite
│        (Real PostgreSQL Wasm)         │  (isolated, no external network/Docker)
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│  scripts/generate-database-types.mjs  │  Introspects information_schema &
│       (npm run db:types:verify)       │  pg_proc; validates types/supabase.ts
└───────────────────┬───────────────────┘
                    │
                    ▼
┌───────────────────────────────────────┐
│     CI Release Gate (.github/ci.yml)  │  Fails build if schema and TypeScript
│                                       │  types differ or RPCs lack types
└───────────────────────────────────────┘
```

### 2.1 Disposable Database Environment
In CI (or wherever `@electric-sql/pglite` is present), the validation engine:
1. Instantiates a clean, in-memory PostgreSQL instance (`PGlite`).
2. Provisions required mock roles (`authenticated`, `anon`, `service_role`) and storage buckets.
3. Applies `supabase-setup.sql` and migration sequences deterministically.
4. Introspects `information_schema.tables`, `information_schema.columns`, and `pg_proc`.
5. Cross-checks against committed TypeScript definitions in `types/supabase.ts`.

When run in environments without `node_modules` (e.g. offline dev environments), the tool falls back to a deterministic static DDL parser.

---

## 3. Strongly Typed RPC Boundaries

Critical database functions are explicitly typed at the interface boundary to eliminate loose `Json` casts and runtime uncertainty:

| RPC Function | Typed Parameters (`Args`) | Typed Return (`Returns`) |
|---|---|---|
| `check_auth_rate_limit` | `p_key`, `p_limit`, `p_window_ms`, `p_now` | `{ allowed: boolean; remaining: number; resetMs: number; count: number; }` |
| `check_rate_limit` | `p_key`, `p_limit`, `p_window_ms`, `p_now` | `{ allowed: boolean; remaining: number; resetMs: number; count: number; }` |
| `claim_trip_invite` | `p_token_hash`, `p_claiming_wallet`, `p_selected_member_id?`, `p_expected_trip_id?` | `{ success: boolean; trip_id: string; trip_name: string; member_id: string; member_name: string; }` |
| `verify_trip_invite` | `p_token_hash` | `{ invite_id: string; trip_id: string; trip_name: string; trip_description: string \| null; member_id: string \| null; member_name: string \| null; inviter_wallet: string; expires_at: string; unclaimed_members: Array<{ id: string; name: string }> \| null; }` |
| `claim_contact_profile` | `p_token_hash` | `{ status: "verified" \| "pending_notice"; contact_name: string; owner_wallet: string; notice_until?: string \| null; }` |
| `delete_user_account` | `p_wallet_address` | `{ success: boolean; wallet_address: string; deleted_at: string; }` |
| `record_migration_v2` | `p_version`, `p_name`, `p_migration_id`, `p_sequence`, `p_manifest_checksum` | `undefined` |
| `update_expense_versioned` | Versioned expense payload | `ExpenseRow[]` |
| `mark_share_paid` | `p_expense_id`, `p_member_id`, `p_tx_hash`, `p_on_chain?` | `ExpenseRow[]` |
| `mark_shares_paid_batch` | `p_updates`, `p_tx_hash` | `ExpenseRow[]` |
| `void_expense` | `p_expense_id`, `p_reason` | `ExpenseRow[]` |
| `record_share_installment` | `p_expense_id`, `p_member_id`, `p_installment` | `ExpenseRow[]` |

---

## 4. CLI Commands & CI Gate

### Verify Database Types (Release Gate)
```bash
npm run db:types:verify
```
Fails with non-zero exit code if:
- Any SQL table is absent from `types/supabase.ts`.
- Any SQL table column is absent from `types/supabase.ts`.
- Any critical RPC function is missing from `Functions`.
- Any critical RPC function returns generic `Json` or `any`.

### CI Workflow Integration (`.github/workflows/ci.yml`)
Inside the `database-schema` job:
```yaml
- name: Database types match disposable schema (Release Gate)
  run: npm run db:types:verify
```

Any pull request modifying database DDL or migrations without updating TypeScript types fails CI immediately.
