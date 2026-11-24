# Shared Household Coordination Research Prototype

Household chores are an optional trip module for flatmates. It is isolated from
expense splitting and settlement: creating, rotating, completing, or archiving
a chore does not create a payment, edit an expense share, or change a balance.

## Prototype behavior

- A trip owner must explicitly enable the module. It is disabled by default.
- Any current trip member can add a chore with weekly, biweekly, or monthly
  cadence, a first due date, and a chosen wallet rotation.
- Completion is accepted only from the current eligible assignee and for the
  chore's due date. A database transaction records the completion, advances the
  due date and rotation, and rejects a duplicate completion for the same cycle.
- Members can opt out at any time. Opted-out or no-longer-active wallets are
  skipped when selecting the next assignee.
- A chore's creator can archive it without erasing its completion history.
- Completing a chore can optionally reference an expense already linked to the
  same trip. It cannot create or update an expense.
- Disabling the module hides its chores/history and blocks further reads and
  writes until the owner enables it again. The records are retained.

The migration appends chore data to the database. `household_chore_completions`
is append-only for clients; the completion RPC validates assignment, module
state, membership, opt-out, due date, and any supply expense reference. RLS
limits data to trip members, and the module setting is owner-only.

## Setup

Apply `migrations/0019_shared_household_coordination.sql` with the normal
migration workflow:

```powershell
npm run db:status
npm run db:migrate
```

The tab is available on a trip detail page. The owner enables the research
pilot from that tab; members can then manage their own opt-out choice.

## Pilot boundary

This is a research prototype, not a general-release commitment. Run the
consent-based pilot and record the measurements in
[PILOT_FEEDBACK_METRICS.md](./PILOT_FEEDBACK_METRICS.md) before making a
general-release decision. The agreed success thresholds, opt-out behavior,
financial isolation, and participant feedback must all be reviewed. Do not
claim improved retention until measured against the pre-defined comparison.
