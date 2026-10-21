# Trip roles and permissions

Trip roles are stored on each member in `trips.members`. The same permission
names are evaluated by the TypeScript role helpers and PostgreSQL RLS
functions; the database is authoritative for writes.

| Permission | Owner | Organizer | Contributor | Viewer | Custom |
|---|:---:|:---:|:---:|:---:|:---:|
| Manage trip settings and workspace | Yes | Yes | No | No | Assigned |
| Manage membership and invitations | Yes | Yes | No | No | Assigned |
| Create, edit, delete, and link expenses | Yes | Yes | Yes | No | Assigned |
| View, upload, and remove receipts | Yes | Yes | Yes | No | Assigned |
| Export trip data | Yes | Yes | Yes | Yes | Assigned |
| Manage reminders and reminder schedules | Yes | Yes | No | No | Assigned |
| Create and manage settlement proposals | Yes | Yes | No | No | Assigned |

Custom assignments receive only their explicitly selected permissions. Valid
permission identifiers are `trip.settings.manage`, `members.manage`,
`expenses.manage`, `receipts.manage`, `exports.view`, `reminders.manage`, and
`settlement.proposals.manage`. Unknown roles or permissions are rejected by
the database; legacy members without a role resolve to owner only when their
wallet is the trip creator, and otherwise resolve to contributor.

Owners alone may assign roles. Role assignment writes update `trips.members`
and append to `trip_role_audit` in the same transaction, so affected members
see the new role in the trip and can open **View role history** in the member
list to read the actor, timestamp, role transition, and custom-permission
changes. All current trip members can read the history; audit rows are
append-only to authenticated clients.

An owner cannot demote or remove the final wallet-backed owner by editing the
member list or using role assignment. Ownership changes use the explicit
`POST /api/trips/{tripId}/transfer-ownership` flow: it promotes the selected
member, moves the transferring owner to organizer, and records both changes
atomically. An owner without a wallet cannot be selected as the recipient.

`migrations/0016_trip_roles_and_permissions.sql` applies the database
functions, triggers, and policies. `supabase-setup.sql` keeps the same
objects for fresh installs. Role changes, membership/settings writes, expense
mutations, receipts, reminders, exports, and settlement proposals are checked
at the API boundary where elevated clients are used and again by RLS or
database RPCs.
