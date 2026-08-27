# Design Note: Closing the Settlement Trust Boundary

Issue #144 (epic #42). Seam **S3**. Single-asset — multi-asset pool routing is #43.

## The problem

`record_payment` stored whatever `tx_hash` it was handed. Whether that hash
corresponded to a real payment of the right amount to the right account was
checked in `lib/stellar/verifyTransaction.ts` — in the browser of the person who
benefits from the answer. Anyone could call the contract directly with
`stellar contract invoke` and a fabricated hash; `is_paid` would return true and
the app would show the debt settled "on-chain". The verifiable proof was not
verifiable.

A Soroban contract cannot read Horizon. There is no host function for it and
there will not be one. So the proof has to come from somewhere trusted, and the
work is designing that trust anchor and then defending it.

## The approach taken

An off-chain **attestation oracle** verifies the payment against Horizon
server-side and signs the claim with an ed25519 key. The contract verifies that
signature against a key it was initialised with, and refuses to record anything
without one.

### 1. What the signature covers

The oracle signs a canonical message built from the *whole* claim: domain tag,
settlement contract address, trip, expense, payer, member, amount, asset, tx
hash, nonce, and expiry. The contract rebuilds that message **from the arguments
it was actually called with** (`contract/src/attest.rs`) and verifies. So there
is nothing for a caller to lie about: change any field and the rebuilt message
differs, the signature fails, the call reverts. Cross-expense reuse, amount
inflation, and payer substitution are all the same non-attack.

The encoding is the concatenation of each field's XDR `ScVal`. `ScVal`s are
self-delimiting and the field order and types are fixed, so concatenation is
unambiguous — and unlike serialising a struct as one map, there is no key
ordering convention for the Rust and TypeScript sides to disagree about. If they
ever drift, every attestation is rejected on-chain: a loud failure, which is the
safe direction.

The contract address is in the message, so an attestation minted for one
deployment does not verify on another. Contract addresses are network-derived,
so this binds the network too.

### 2. Single-use: a nonce burned on-chain

Each attestation carries a random 32-byte nonce. The contract stores it in
persistent storage on use and rejects any attestation whose nonce is already
there. The burn is what makes consumption *final*, and it is deliberately the
contract that does it, not the oracle — that is what makes invariant 3 hold
"across concurrent submissions and across multiple oracle instances". Two
transactions racing on the same nonce conflict on the same ledger entry; the
loser is re-simulated against the burned entry and rejected. No amount of
oracle-side coordination is needed, or trusted.

`AlreadyPaid` does not subsume this. The contract test
`test_nonce_reuse_across_distinct_claims_rejected` uses two genuinely different
claims sharing a nonce, and `test_duplicate_payment_rejected` uses two genuinely
different nonces on one expense — each guard is proven to stand alone.

### 3. Bounded validity

`expires_at` must be in the future and no more than `MAX_ATTESTATION_TTL_SECS`
(900s) out; the oracle mints for 300s. This bounds the blast radius of a stolen
key: an attacker who signs a batch of claims has minutes to land them, not
forever. `set_oracle_key` (admin-only) kills every outstanding attestation
immediately — the compromise response. It is deliberately not the oracle's own
privilege: a compromised oracle must not be able to re-anchor trust in itself.

### 4. The oracle trusts Horizon, not the caller

`lib/settlement/horizonVerify.ts` takes the tx hash **as a lookup key only**.
Source, destination, asset, and amount are read out of Horizon's response and
returned as facts. The endpoint compares those facts to the request's assertions
and *rejects* on disagreement rather than silently signing different values. It
sums only operations between the verified source and destination, so a
third-party payment riding in the same transaction cannot pad the amount.

The endpoint also requires a wallet session and checks `wallet_address ===
member`. Otherwise anyone could have an attestation minted in a stranger's name
and burn their pool credit.

### 5. One payment cannot settle two debts

The contract cannot see that two claims share a transaction, so a debtor could
otherwise take one real 10 XLM payment and request a separate valid attestation
per expense. `lib/settlement/attestationLedger.ts` closes this: a
`(txHash, expenseId, member)` triple is attested at most once, and the sum
attested against a hash never exceeds what the transaction actually paid. Backed
by Supabase with a unique constraint when configured — which is what makes it
hold across instances — and a process-local map otherwise. `durableLedger` in
the response says which, so an operator running several instances without the
table is told rather than finding out from a double-spend.

This is also what makes net settlement work: one payment, several expenses,
attested individually and bounded in total by the payment.

### 6. Key custody

The signing key is a Stellar secret seed in the server-only
`SETTLEMENT_ORACLE_SECRET`. Stellar keys *are* ed25519 keys, so one seed gives
signing here and a raw 32-byte public key for the contract — no extra dependency
and no second key format. `lib/settlement/oracleKey.ts` refuses to run at all if
it finds an oracle secret under a `NEXT_PUBLIC_` name, since Next.js inlines
those into the browser bundle: such a key is already published and must be
treated as burned, not quietly ignored in favour of the right variable. The key
is resolved per call, so a missing key fails the requests that need it —
degrading settlement — rather than failing to boot, and rotation takes effect
without a restart.

### 7. Availability: degrade, never fake

Invariant 5 is the one that is easy to violate by accident in two hooks
independently, so it is implemented once in `lib/settlement/settleOnChain.ts`.
The endpoint distinguishes 503 (cannot answer — unconfigured, Horizon down,
ledger unreachable) from 4xx (looked, and says no). The client maps those to
`retryable` and surfaces "Payment sent — recorded off-chain only", with the
existing pending-retry record so the user can complete it later. It never
reports on-chain proof it does not have. The XLM still moves and the debt is
still recorded off-chain; only the proof is deferred.

### 8. What happened to the pool `withdraw`

Kept, but **moved after the attestation gate and the nonce burn**. Previously it
ran on the same unguarded path, so an unattested call could move a member's pool
credit. Now no rejected call touches it — `test_rejected_attestation_leaves_pool_balance_untouched`
asserts exactly that. The attested asset is additionally checked for equality
against the deployment's configured settlement asset, so an attestation minted
for some other asset cannot authorise a debit denominated in this one. That
check is an equality rather than a lookup precisely because this is single-asset
today; #43 turns it into routing.

## Alternatives considered and rejected

**A. Oracle as sole writer.** Make the oracle the only account allowed to call
`record_payment`. Simpler — no signature scheme, no nonces, no canonical
encoding. Rejected on availability: it makes the oracle a hard dependency for
settlement, so an oracle outage means nobody can settle at all, and a settlement
app that cannot settle is worse than one with a theoretical hole. The
attestation model keeps the *user* as the transaction submitter, so the oracle
is on the proof path but not the value path, and its downtime degrades rather
than blocks. It also concentrates a spending-like privilege in an always-on
internet-facing service.

**B. Bind the attestation to the expense only, with no nonce.** Much less
machinery: sign `(expense_id, amount)`, let `AlreadyPaid` handle uniqueness.
Rejected because `AlreadyPaid` is keyed on `(expense_id, member)`, so one
attestation would be replayable across trips that reuse expense ids, and there
would be no way to invalidate an attestation short of the payment landing. The
issue calls this hole out directly. A nonce burned on-chain is the only version
of "single-use" that survives multiple oracle instances, since it needs no
coordination between them.

**C. Threshold / multi-oracle signing (M-of-N).** Several independent oracles,
contract verifies a quorum. Genuinely stronger — it removes the single trusted
key, which is the residual weakness of the chosen design. Rejected as
disproportionate for a testnet-oriented app with one operator: it multiplies the
verification cost in the contract, needs a key registry and rotation protocol
per oracle, and every oracle would be reading the same Horizon, so the
independence it buys is smaller than it looks. The chosen design is
forward-compatible — `get_oracle_key`/`set_oracle_key` become a key set, and the
claim encoding does not change.

**D. Store a hash commitment on-chain and verify the payment lazily.** Have the
contract record an unverified claim, and let anyone challenge it later with a
fraud proof. Rejected because the contract still cannot read Horizon, so the
challenge would have to be adjudicated by — an oracle. It adds a dispute window
and a bond mechanism without removing the trust anchor.

## Residual weaknesses, stated plainly

- **The oracle key is a single point of trust.** Anyone holding it can mint
  proof of a payment that never happened. Mitigated by short TTLs, admin-held
  rotation, and server-only custody; not eliminated. Alternative C is the path
  if that becomes unacceptable.
- **The in-memory ledger fallback is single-instance only.** Without Supabase
  configured, running several oracle instances would let one payment be
  over-allocated. The response reports `durableLedger: false` so this is visible
  rather than silent.
- **Forgery traps rather than returning an error code.** `ed25519_verify` is a
  host function that panics; there is no fallible variant. Callers get a host
  error, not a `ContractError`, which is why the forgery tests assert
  `should_panic` rather than a specific code.
- **Horizon is trusted.** The oracle's verification is only as good as the
  Horizon instance it queries.

## Test coverage

- `contract/src/lib.rs` — 41 tests, all passing. Adversarial cases: forgery with
  a wrong key, unattested fabricated hash, attestation minted for another
  contract, replay, nonce reuse across distinct claims, cross-expense reuse,
  cross-trip reuse, tampering with each of amount / tx hash / payer / member /
  expiry / nonce, expired attestation, over-long TTL, asset mismatch, key
  rotation invalidating old attestations, and pool balance untouched by a
  rejected call.
- `__tests__/settlement/attest.test.ts` — encoding determinism, domain
  separation, and per-field tampering against the client verifier.
- `__tests__/settlement/horizonVerify.test.ts` — derived-facts behaviour,
  transient-vs-verdict classification, multi-operation summing.
- `__tests__/settlement/attestationLedger.test.ts` — allocation accounting and
  idempotence.

## Deployment

1. `./scripts/deploy-contract.sh <deployer> <token-id> [oracle-secret]` —
   generates an oracle keypair if not given, and initialises the contract with
   its raw public key and the settlement asset.
2. Set `SETTLEMENT_ORACLE_SECRET` (server-only) and
   `NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY` / `NEXT_PUBLIC_SETTLEMENT_ASSET_ID`.
3. Run the `settlement_attestations` section of `supabase-setup.sql`.

Without steps 2–3 the app degrades to off-chain-recorded settlement, which is
the designed behaviour, not a failure.
