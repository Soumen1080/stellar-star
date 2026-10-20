# Partial settlement: paying a share in installments (#325)

A member can settle one share over several on-chain payments. The remaining
balance stays exact the whole way through, and the share counts as settled only
once that balance reaches zero.

## Data model

Shares still live in `expenses.shares` (JSONB). A share paid in parts gets two
extra keys:

| Key | Meaning |
|---|---|
| `amount` | What the member **owes** (unchanged) |
| `installments[]` | One entry per payment: `seq`, `amount`, `amountStroops`, `txHash`, `ledger`, `claimId`, `attestationNonce`, `verified`, `onChain`, `paidAt` |
| `paidStroops` | Sum of `installments[].amountStroops` |
| `paid` | `true` **only** when paid = owed |

Owed, paid and remaining come from `shareBalance()` in
`lib/settlement/installments.ts`, in integer stroops (`bigint`). A share with no
`installments` key behaves exactly as before. Paying the whole share in one go
still uses the original single-payment path.

## Overpayment

Overpayment is rejected, never turned into credit without being asked for:

1. `planInstallment()` refuses, before anything is signed, any amount above the
   remaining balance (`OVERPAYMENT`), as well as zero, negative or over-precise
   amounts.
2. `record_share_installment` (migration `0012`) locks the expense row
   (`SELECT … FOR UPDATE`), re-checks in NUMERIC stroops, and raises SQLSTATE
   `23514` on overpayment. The client surfaces this as `InstallmentRejectedError`.
3. If a payment lands on Stellar and is then refused at write time (the balance
   changed underneath it), it is **not** applied as credit. The payer is told the
   payment landed and needs a refund or a credit, and the intent is marked failed.
   Any credit flow has to be explicit.

## Verification and on-chain proof per installment

Each installment is attested and recorded on its own, under the claim id
`<expenseId>#<seq>`:

- The oracle checks every installment's transaction against Horizon. Its
  allocation ledger is keyed by `(txHash, claimId, member)`, so one transaction
  cannot be attested twice.
- The contract's `AlreadyPaid` guard is keyed by `(expense_id, member)`. A
  separate claim id per installment means a second installment is never blocked
  by the first, and **a partial payment can never mark the plain expense id paid
  on-chain**.
- The installment entry stores `txHash`, `attestationNonce`, `verified` and
  `onChain`. A later contract-record retry stamps them in through
  `updateInstallmentProofRow` (metadata only; it never changes amounts or `paid`).

Claim ids fit the contract's 64-character id limit (a UUID plus `#999`).

## Net settlement

`SettlementSummary` and `computeTripBalances` feed **remaining** balances into
netting. A partly paid share is never dropped as settled, and never re-billed for
its original amount. On-chain trip reconciliation maps `<expenseId>#<seq>` records
back to installments, and matches a plain-id record against a part-paid share's
remaining balance.

## Concurrency and retries

- Each installment holds its own intent lock: idempotency key
  `settle:<trip>:<expense>:<member>:installment-<seq>`. Two clients racing for the
  same installment collide on the UNIQUE key, so only one signs.
- A one-shot payment and a first installment also check each other's in-flight
  intent, so they cannot both spend the same balance.
- Before planning, `payShare` re-reads the share. A payment made from another
  device is then counted before anything is signed.
- Retry after submit: if the app loses the write after Horizon accepted the
  transaction, the intent stays `submitted` with its `txHash`. The next attempt
  reconciles that transaction (Horizon-verified, recorded once by `txHash`)
  instead of paying again.

Tests: `__tests__/settlement/installments.test.ts` (rules, netting, keys) and
`__tests__/payment/usePayment.installments.test.tsx` (concurrent installments,
overpayment, retry after submit, idempotent reconciliation).
