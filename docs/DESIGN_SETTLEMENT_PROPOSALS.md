# Settlement proposals and member confirmation (#328)

For larger groups, settlement can start from a frozen **proposed settlement**.
Members agree which expenses and balances are included before anyone pays.

## The snapshot (`lib/settlement/proposal.ts`)

`buildProposalSnapshot()` freezes:

- **Included expenses:** every trip expense that still has something owed, with
  its `version`, settlement asset, total, payer and per-share amount and paid
  state;
- **Balances:** each member's net per asset, as exact decimal strings;
- **Assets:** never netted across each other;
- **Transfers:** the simplified payments that settle those balances;
- **Participants:** the members with a non-zero balance and a wallet, who must
  confirm;
- **Creator, `createdAt` and `expiresAt`:** 1 hour to 14 days (default 3 days).

The **content hash** is SHA-256 over canonical JSON (keys sorted, arrays in a
fixed order, amounts exact). The same inputs always give the same hash, on any
client. Every reader recomputes it from the stored snapshot. A mismatch marks
the proposal `tampered`, and it can neither collect approvals nor authorize
payments. A database trigger also freezes the snapshot, hash, creator and
expiry after insert.

## Confirmation

On the *Settle* tab, each participant can:

- **Approve**;
- **Reject**, with a required reason;
- **Request an edit**, with a required reason.

Responses are append-only, and each member's latest one counts. Every response
records the content hash it answered, so it only ever counts for that exact
snapshot.

| Status | When |
|---|---|
| `open` | Waiting for answers |
| `approved` | Every participant's latest answer is *approve* |
| `rejected` / `edit_requested` | Any participant rejected or asked for an edit |
| `invalidated` | A material change happened since the snapshot. All approvals are void. |
| `expired`, `revoked` (creator), `superseded` (a newer proposal) | As named |

**Material change** (`detectMaterialChanges`): an included expense's total,
share amounts, members, payer or asset changes; an included expense is
removed; a paid share becomes unpaid; or a new expense with something owed is
added to the trip. A share being *paid* is settlement progress and does not
count. When a client sees a change, it records the proposal as `invalidated`.
Anyone can then propose again from the current balances.

## Paying from a proposal

`proposalPaymentGate()` decides each settlement row:

- **Approved, and the row matches one of the snapshot's transfers:** it pays
  *from the proposal*. The row shows `From proposal <REF> · memo SSP:<REF>`,
  and the transaction memo is `StellarStar|SSP:<REF>`, which fits the 28-byte
  memo limit.
- **Still awaiting answers** (`open`, `edit_requested`): payment waits, since
  members are still deciding what to pay.
- **Expired, revoked, superseded, invalidated, rejected or tampered:** the
  proposal **authorizes nothing**. The row says so, and the payment goes ahead
  without the proposal's reference.

`authorizeProposalPayment()` is the single rule. It returns `EXPIRED`,
`REVOKED`, `INVALIDATED`, `NOT_APPROVED` or `NOT_IN_PROPOSAL`, or the
reference and memo.

## Storage

Migration `0014_settlement_proposals.sql`:

- `settlement_proposals`: at most one `open` proposal per trip. Proposing again
  supersedes the previous one.
- `settlement_proposal_responses`: append-only.

RLS limits both tables to trip members. Only the creator can revoke. A
response can only be added by the member themselves, to an open, unexpired
proposal, and with the proposal's current hash.

Tests: `__tests__/settlement/proposal.test.ts` (snapshot, hash, confirmation,
material changes, lifecycle, payment authorization) and
`__tests__/components/trips/SettlementProposalFlow.test.tsx` (propose, blocked
until approval, paying with the reference memo, revoked proposals, rejection
reasons).
