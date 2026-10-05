# Dashboard query index verification

Issue #267 adds indexes for the query shapes that exist in this schema. Trips
store `expense_ids` and embedded `members`; there is no `expenses.trip_id` or
`trip_members` table, so indexes on those suggested columns would never be
usable.

Run the analyzer after provisioning a disposable database:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/verify-query-indexes.sql
```

The script disables sequential scans inside a rolled-back transaction so small
test datasets still prove index coverage without changing data. Verified on
PostgreSQL 16 after both a complete `migrations/*.sql` replay and a fresh
`supabase-setup.sql` provision:

| Query shape | Index selected |
| --- | --- |
| Expense membership | `idx_expenses_member_wallets` |
| Expense creator + newest first | `idx_expenses_creator_created_at` |
| Expense status + newest first | `idx_expenses_settled_created_at` |
| Trip membership | `idx_trips_member_wallets` |
| Trip creator + newest first | `idx_trips_creator_created_at` |
| Trip status + newest first | `idx_trips_settled_created_at` |
| Trip invitations + newest first | `idx_trip_invites_trip_created_at` |
| Active settlement intents | `settlement_intents_member_status_created_at_idx` |
| Oldest challenge per wallet | `auth_challenges_address_created_at_idx` |

The migration also changes wallet RLS predicates from `wallet = ANY(array)` to
the GIN-indexable `array @> ARRAY[wallet]` form. Without that operator change,
the expense/trip membership indexes exist but cannot serve the policy filter.
