# Trip templates & duplicate-from-history (#321)

Repeated groups (flatmates, teams, annual trips) can save a trip's structure as a
template, or start a new trip from a template or a past trip.

## What is copied

| Copied (editable before creation)        | Never copied                         |
|------------------------------------------|--------------------------------------|
| Name, description                        | Expenses (`expense_ids`)             |
| Members (fresh ids, canonical wallets)   | Shares, paid flags, tx hashes        |
| Recurring expense rules (payer remapped) | Balances / who-owes-whom             |
| Permissions                              | Settled status                       |
| Trip length → suggested dates            |                                      |

`lib/trip/templates.ts` builds every copy from an explicit allow-list, so a new
field on `Trip` is excluded by default. `create_trip_from_copy` additionally
forces `expense_ids = '{}'` and `settled = FALSE` regardless of the payload.

Member ids are regenerated on every copy so a stale share can never appear to
belong to a member of the new trip; recurring rules are remapped with them.

## Idempotency & audit

- The client creates one idempotency key when the user picks a source (or opens
  "Save as template") and reuses it on every retry.
- `create_trip_from_copy` / `save_trip_template` claim the key in
  `trip_copy_events` (`UNIQUE (idempotency_key)`) before writing. A replay — or a
  concurrent duplicate that blocks on the unique index — returns the row the
  first call created.
- `trip_copy_events` is append-only: RLS has INSERT and SELECT policies only, and
  the audit row is written in the same transaction as the copy, so it exists if
  and only if the copy succeeded.
- Both functions are `SECURITY INVOKER`: a source the caller cannot read under
  RLS is reported as `COPY_SOURCE_NOT_FOUND`.

## Permissions

`trips.permissions` holds `membersCanAddExpenses` and `membersCanInvite`
(default `true`). The trip creator can always do both. They are enforced in the
trip UI (`canPerformTripAction`); database-level enforcement is a follow-up.

## Schema

Migration `0008_trip_templates.sql` (mirrored in `supabase-setup.sql`) adds
`trips.starts_on/ends_on/recurring_rules/permissions/source_template_id/
copied_from_trip_id`, the `trip_templates` and `trip_copy_events` tables, and the
two functions. **Apply it before deploying this code** — `fetchTrips` selects the
new columns.
