# Design Note: Onboarding Users With No Funded Account

Issue #147 (epic #45).

## The problem

A Stellar account does not exist until it is funded, and each trustline raises
the minimum reserve by 0.5 XLM. So a new user with an empty wallet has no
account at all: `getXLMBalance` returns a Horizon 404, and the app surfaced that
as "something failed" and stopped.

Every group expense app lives or dies on whether you can add the friend who has
never heard of it. That 404 was where the product ended.

## Decision 1: sponsored reserves, not a gift

The obvious alternative is `createAccount` with a real starting balance — gift
1.5 XLM and move on. It is simpler and needs none of the machinery below.

It was rejected because **a gift is permanently gone**. Most invitees to a
consumer app never return; gifting means the cost of an abandoned invite is
unrecoverable, and the sponsor's balance ratchets down forever. Sponsored
reserves lock the same XLM but keep it *recoverable*: revoking returns it.

Over a population that mostly churns, that is the difference between a
permanent cost and a temporary one — and it is what makes a bounded cap a
workable operating model rather than merely a spending limit that eventually
empties.

The trade-off accepted, plainly: sponsorship is a durable liability. It needs a
ledger, a cap, and a revocation path — everything in `lib/onboarding/`. A gift
needs none of that. We took on the complexity to keep the money recoverable.

## Decision 2: the sandwich, and who signs

Sponsored reserves are a sandwich, and the ordering is load-bearing:

```
BeginSponsoringFutureReserves(sponsoredId: newAccount)  [source: sponsor]
CreateAccount(destination: newAccount, startingBalance: 0)
ChangeTrust(asset)                                      [source: newAccount]
EndSponsoringFutureReserves()                           [source: newAccount]
```

`startingBalance: 0` is the whole point: the reserve is *sponsored*, not
transferred, so the lumens remain the sponsor's and unlock on revocation.

`EndSponsoring` is sourced from the new account, so **the new account must
sign**. That is not an obstacle to work around — it is invariant 4 enforced by
the protocol. The server signs only the sponsor's half and returns a partially
signed transaction that is inert until the invitee signs it in their own wallet.
The server never holds the invitee's key and therefore cannot create an account
the invitee does not control, nor act on their behalf afterwards.

The trustline is included in the same sandwich so the created account can
actually receive the asset, rather than existing but needing a second top-up
immediately.

## Decision 3: a hard cap, reserved before submission

`SPONSORSHIP_CAP_STROOPS` is a fixed number, not a percentage of the sponsor's
balance. A cap that floats with the balance is not a cap, it is a slope.

Capacity is reserved **before** the transaction is submitted. Reserving
afterwards leaves a window in which concurrent requests each observe headroom
that is about to be consumed, and the cap is exceeded by however many requests
fit in that window. Reserving first makes the ledger pessimistic: a submission
that then fails leaves a stale reservation, which `releaseFailedReservation`
cleans up. The error direction is under-spending, which is the right way for
this to be wrong.

Exhaustion is surfaced as a distinct state with its own explanation, and always
alongside the self-funding path — the user is told what *they* can still do
rather than shown a wall.

## Decision 4: abuse resistance keys on the inviter

Invitee addresses are free to generate, so they are worthless as a rate-limiting
key. Every cost attaches to the **inviter**:

1. **An established inviter.** Only a funded wallet with a proven-ownership
   session can sponsor. Creating a fresh inviter therefore costs a real funded
   account — the very thing sponsorship provides — so the attack cannot
   bootstrap itself from the accounts it creates.
2. **A per-inviter quota.** N accounts requires N/quota distinct funded
   inviters, so attacker cost grows linearly in N instead of amortising to zero.
3. **A cooldown.** Converts a scripted burst into a slow drip that monitoring
   can catch.

None is sufficient alone. Together, the marginal cost of the Nth sponsored
account is bounded below by acquiring and funding roughly N/quota Stellar
accounts — which satisfies invariant 5's "costs something that scales".

The inviter is taken from the authenticated session, never from the request
body. Letting the client name its own inviter would make every limit voluntary.

## Decision 5: revocation is implemented, and open to the user

`POST /api/onboarding/revoke` builds, signs, and **submits** the revocation.
Invariant 3 asks for the path implemented rather than described, and a
revocation that only exists in a document does not return anyone's XLM.

Two callers, for different reasons:

- **The sponsored user**, at any time. Once they can cover their own reserve
  they may want independence, and refusing to release them is a form of holding
  them — which invariant 4 is about.
- **The operator**, for accounts idle past the reclaim window. Deliberately
  *only* idle ones: an operator key that could cut off active users is a worse
  failure than a slowly filling cap.

Revocation never takes anything from the user. If the account cannot cover its
own reserve, the network rejects the operation and the sponsorship simply
stands. Reclamation is best-effort by design, and the endpoint says so
(`sponsorshipRetained: true`).

The ledger is updated only *after* the network accepts. Marking it revoked first
would free cap headroom for reserves that are still locked.

## Alternatives considered and rejected

**A. Claimable balances.** Send value to an address that does not exist yet.
Genuinely useful, and rejected because it solves the wrong half: the claimant
still needs a funded account to claim it. It moves the dead end rather than
removing it. It remains a good fit for sending *value* to a known-existing
account, which is not this problem.

**B. Fee-bump transactions.** Let the app pay fees for the new user. Rejected
for the same reason: fee bumps cover fees, not reserves, and it is the reserve
that gates account existence. A user with a fee-bumped transaction and no
reserve still has no account. Worth adding later for the separate problem of a
reserve-locked user who cannot afford fees.

**C. A public faucet / friendbot proxy.** Simplest possible: call friendbot.
Rejected because it is testnet-only, so it is not a design that survives
contact with mainnet, and it has no abuse resistance whatsoever — the invariant
5 requirement is unmeetable.

**D. Gifting XLM outright.** Covered in Decision 1. Simpler, permanently more
expensive, and unbounded in the direction that matters.

**E. Requiring the invitee to self-fund.** No sponsor, no liability, no
complexity. Rejected because it *is* the current dead end, and invariant 1
forbids it: the user must be able to settle without leaving the app for an
external faucet. Self-funding is retained as the fallback for every case where
sponsorship cannot be offered, which is where it belongs.

## Residual weaknesses, stated plainly

- **The in-memory ledger fallback is single-instance only.** Without Supabase
  configured, the cap is per-process — on a multi-instance deployment that is N
  times the cap the operator set. The capacity endpoint reports
  `durableLedger: false` so this is visible rather than silent.
- **A determined attacker with real XLM can still consume capacity.** The costs
  scale, but they are not prohibitive at small N. The cap bounds the damage to a
  denial of sponsored onboarding — self-funding still works — rather than a loss
  of funds.
- **Reclamation cannot force a release.** If a sponsored account holds no XLM of
  its own, revocation fails and the reserve stays locked indefinitely. This is
  the honest cost of never taking anything from a user: a permanently dormant
  sponsored account holds 1.5 XLM forever.
- **The sponsor key is a single point of failure.** Anyone holding it can drain
  the sponsor directly, which no cap prevents — a cap does not apply to someone
  signing transfers with the key itself. Same custody rules as the oracle key.
- **Base reserve is assumed at 0.5 XLM.** It is a network parameter and can
  change by validator vote. A change would make the constants wrong until
  updated.

## Test coverage

- `__tests__/onboarding/accountState.test.ts` — the **unfunded** case (404 as a
  state, not an error), the **partially funded** case (reserve-locked, trustline
  unaffordable), and the funded case, plus a counterfeit-issuer trustline.
- `__tests__/onboarding/sponsorshipLedger.test.ts` — the **sponsor-exhausted**
  case: refusing past the cap, never committing beyond it under repeated
  attempts, and headroom returning on revocation. Also reservation idempotence,
  failed-reservation cleanup, and idle reclamation with activity deferral.
- `__tests__/onboarding/abuseResistance.test.ts` — each of the three costs
  independently, and the combined property that one funded wallet cannot exceed
  its quota however many invitee addresses it generates.

## Deployment

1. Fund a sponsor account and set `SPONSOR_SECRET_KEY` (**server-only** — never
   `NEXT_PUBLIC_`; `lib/onboarding/sponsorKey.ts` refuses to run if it finds
   one, since such a key must be considered drained).
2. Set `SPONSOR_OPERATOR_SECRET` for the reclamation endpoint.
3. Run the `sponsored_accounts` / `sponsorship_invites` section of
   `supabase-setup.sql`.
4. Optionally tune `SPONSORSHIP_CAP_STROOPS`,
   `MAX_SPONSORSHIPS_PER_INVITER`, `INVITE_COOLDOWN_MS`, and
   `INVITER_MIN_SPENDABLE_STROOPS`.

Without step 1 the app degrades to self-funded onboarding, which is the designed
fallback rather than a failure.
