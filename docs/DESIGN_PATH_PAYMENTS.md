# Design Note: Settling in an Asset You Do Not Hold

Issue #146 (epic #44). Seam **S1** (`lib/stellar/assets.ts`), created here.

## The problem

If a bill is denominated in USDC and the debtor holds only XLM, they are stuck.
Stellar solves this natively: `pathPaymentStrictReceive` lets the sender spend
XLM while the recipient receives an exact USDC amount, atomically, through the
DEX. It is the strongest argument for settling on Stellar rather than anywhere
else, and the app did not use it.

## Decision 1: strict-receive, not strict-send

For a debt, the destination amount is the fixed quantity and the source amount
is the variable. `pathPaymentStrictReceive` matches that exactly: `destAmount`
is guaranteed, `sendMax` is the ceiling.

Strict-*send* fixes what you spend and lets the recipient receive whatever that
buys. For settling a debt that means underpaying whenever the book moves against
you — the transaction succeeds, and the debt is quietly short. Invariant 1 rules
it out. The network enforces the exact receive, so the guarantee is not
something we check afterwards.

## Decision 2: an explicit, bounded slippage tolerance

`sendMax` is a real spend limit. Set it from a stale quote with no tolerance and
any adverse tick fails the transaction; set it generously and the payer silently
overpays into a thin book. Neither is acceptable, and there is no value that is
safe in both directions — which is why the tolerance is a *displayed control*
rather than a constant.

`deriveSendMax` computes `sourceAmount × (1 + slippage)`, **rounded up**.
Rounding down would produce a limit fractionally below the tolerance the user
agreed to, failing payments at the boundary for no reason.

Default 1%, options at 0.5% / 1% / 3%, hard cap 10%. The default is deliberately
*shown* alongside the worst-case spend it produces (invariant 3) — a default the
user never sees is a silent default no matter how reasonable its value.

## Decision 3: quotes expire, and expiry blocks signing

Horizon's path is a suggestion priced against a book that moves. A quote older
than **30 seconds** is treated as stale: `isQuoteFresh` returns false, the
confirm button disables, and `buildPathPaymentTransaction` refuses to build.

30s is a judgement, not a guarantee — short enough that the book has usually not
moved past the tolerance, long enough to read a confirmation and approve a
wallet prompt.

**Refresh is manual, not automatic.** An auto-refreshing quote changes the
confirmed maximum out from under someone mid-read, which is exactly what
invariant 2 forbids: the number they agreed to must be the number enforced.
Changing the slippage control re-prices the *existing* quote rather than
re-fetching, because the order book did not move because a user clicked a
button.

## Decision 4: price impact is a warning, not a veto

Horizon does not report price impact, so it is derived: the cheapest path found
is the benchmark, and each other path's excess over it is its impact. Above
500bps the route is flagged prominently.

Flagged, not rejected. A thin book is sometimes the only book, and refusing
outright leaves the payer unable to settle at all — a worse outcome than an
informed expensive settlement. The choice to eat the impact is theirs, and the
warning is what makes it a choice.

The honest limitation: with a single path there is no benchmark, so impact reads
0. That is not a claim the route is cheap. `highPriceImpact` warns about the
*chosen route relative to alternatives*, and cannot see absolute badness.

## Decision 5: verification asserts on what arrived

This is the subtlest part and the one most likely to lose money silently.

A path payment appears in Horizon as `path_payment_strict_receive`, not
`payment`. The old check was `op.type === "payment"` in two places — the client
check and the attestation oracle. Either would have rejected a perfectly good
settlement: the payer's money spent, the recipient paid in full, and the app
reporting the debt unpaid.

`lib/stellar/verifyPaymentOperation.ts` normalises both shapes and asserts on
the **destination** fields — `asset_*` and `amount`, which describe what the
recipient received. The `source_*` fields describe what the sender spent, which
on a path payment is a different asset entirely and is not what the debt was
denominated in. Asserting on the source would reject every path payment;
asserting on the destination is correct for both operation types.

Both verification sites now share this module, so they cannot drift apart on
what counts as proof.

## Decision 6: asset identity includes the issuer

S1 exists because comparing asset *codes* is a security bug. Anyone can issue a
token called USDC; only Circle's issuer is Circle's. `assetKey` is
`"CODE:ISSUER"` (or `"native"`), and every comparison goes through it. The test
`rejects the right amount of the wrong asset` is that rule made executable.

Assets outside the registry resolve with `trusted: false` rather than being
rejected — the app can still handle them, but nothing presents an unknown issuer
as known-good on the strength of its code.

## Alternatives considered and rejected

**A. Strict-send with a computed send amount.** Compute what to spend, send it,
let the recipient get what it buys. Rejected: the recipient receives less than
owed whenever the book moves, so the debt silently under-settles. Invariant 1
exists to forbid exactly this.

**B. A fixed slippage constant, no UI.** Far simpler and what most naive
implementations do. Rejected by invariant 3 directly: a tolerance the user never
sees is a silent authorisation to spend more than they expected. The worst-case
spend is the number a payer actually cares about, and hiding it is the failure.

**C. Auto-refreshing quotes on a timer.** Nicer-feeling — the quote never
expires. Rejected because it mutates the confirmed maximum while the user is
reading it, so what they approve and what they agreed to can differ. Visible
expiry with manual refresh is less smooth and strictly more honest.

**D. Rejecting paths above a price-impact threshold.** Considered and
deliberately not done. It converts "expensive but possible" into "impossible",
and the user has no recourse — they cannot see the number to judge it for
themselves. A prominent warning preserves both the information and the choice.

**E. Skipping the trustline pre-check.** The recipient needs a trustline for the
destination asset regardless. Letting it fail on submission is less code, but
produces an opaque `op_no_trust` after the user has already signed. Checking
first turns it into an explainable precondition.

## Residual weaknesses, stated plainly

- **Price impact is relative, not absolute.** With one route available it reads
  0 regardless of how bad that route is. Detecting absolute badness needs an
  independent reference price, which is issue #47's territory (S4 rate quotes).
- **The freshness window is a heuristic.** A book can move past the tolerance
  inside 30 seconds. The consequence is a failed transaction, not an overpay —
  the safe direction — but it is a failure the user has to retry through.
- **No partial-fill handling.** Strict-receive either fills completely or fails.
  That is correct for a debt, but a payer with a large obligation against a thin
  book has no "settle what I can" path.
- **Sequential quote then sign.** Between confirming and the transaction landing
  the book can still move; `sendMax` bounds the loss but cannot eliminate the
  failure case.

## Test coverage

- `__tests__/stellar/pathPayment.test.ts` — `sendMax` derivation including
  round-up and cap enforcement, path discovery against recorded Horizon fixture
  shapes, a **thin-book fixture** whose alternate route is 4000bps worse,
  freshness boundaries, and the three distinct failure reasons.
- `__tests__/stellar/verifyPaymentOperation.test.ts` — path payments accepted as
  proof, assertion on destination rather than source, counterfeit-issuer
  rejection, underpayment rejection.
- `__tests__/settlement/horizonVerify.test.ts` — the oracle accepting a path
  payment that delivers native, and ignoring one that delivers something else.

## Scope note

Wired through `lib/stellar/`, `hooks/usePathPayment.ts`, and
`components/payment/PathPaymentConfirm.tsx`. The settlement contract and
attestation oracle still pin one settlement asset (#144/#145), so today's
end-to-end path is "pay with any asset you hold, recipient receives XLM". The
verification layer is already asset-general, so widening the oracle is the only
remaining step for full multi-asset denomination.
