# Expense disputes (#329)

Disputes are an off-chain review state attached to an expense share. They do
not edit expenses, shares, installments, settlement intents, transaction
hashes, or Soroban records. A confirmed Stellar payment remains a fact even
when a later dispute is raised.

## Settlement pause and resolution

An authorized share member can open one active dispute for their own unpaid
share, with a category and a comment. The database checks trip membership and
the exact share/wallet association; a unique partial index prevents duplicate
open disputes. Open and upheld shares are excluded from balance netting and new
settlement proposals. A newly opened dispute invalidates any proposal that
included that unpaid share. Settlement stays paused when dispute state cannot
be loaded.

An organizer with expense-management permission must record a reason and an
action: **upheld** keeps the share paused; **dismissed** restores eligibility;
**adjusted** restores eligibility after the group has separately recorded the
correction. Resolution uses one database transaction to append the action and
reason and change the dispute state. The original expense is never rewritten.

## Evidence and privacy

Evidence is limited to references to up to five existing active private receipt
records for the same expense. The database rejects public URLs, unrelated
receipts, removed files, and receipts the opener cannot access. Receipt bytes
remain in the existing private storage bucket and use the receipt access
authorization and short-lived links. Dispute comments and category are visible
to trip members under row-level security; they are not written to Stellar,
analytics, or external notification payloads. Do not put secrets or unrelated
personal data in comments or receipts. Existing receipt retention/deletion
rules apply; deleting a file can remove evidence content while the dispute
audit record remains.

## Abuse controls and notifications

Controls include one active dispute per share, strict category allowlisting,
2,000-character comment and 1,000-character resolution-reason limits, a
five-evidence cap, same-expense private receipt checks, and organizer-only
resolution. The UI currently uses in-app state only; it sends no email, push,
or public notification. Members see disputes in the trip settlement view after
refresh/reload. A dispute must not be treated as a payment reversal or as proof
that the underlying expense is false.

## Migration

Apply `migrations/0018_expense_disputes.sql` after `0017_receipt_capture_prerequisites.sql`.
It adds only new dispute and event tables and does not backfill or alter
financial records. No chain migration is required.
