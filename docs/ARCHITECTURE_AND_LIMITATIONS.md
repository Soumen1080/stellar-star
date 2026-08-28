# Architecture Assumptions and Known Limitations

## Architecture Summary

Stellar-star uses:

- Next.js + TypeScript frontend
- Supabase for app data and realtime sync
- Stellar payment operations for value transfer
- Soroban settlement contract for immutable payment recording
- Separate pool contract for inter-contract withdraw flow

## Key Assumptions

- Users operate on Stellar testnet, not mainnet.
- Wallet extensions (Freighter, xBull, Lobstr) are available client-side.
- Supabase anon key is safe with proper RLS policies.
- Wallet authentication uses a server-generated Stellar challenge, client signature verification, and JWT claims; data access is not based on a client-provided wallet header.
- Contract IDs in env/docs are synchronized with deployed testnet contracts.

## Known Limitations

- Project is testnet-oriented; mainnet operational controls are not included.
- Mobile viewport screenshot proof is now included in `README.md` and `public/mobile-responsive.png`.
- CI merge protection enforcement is a GitHub repository setting and must be enabled manually in repo settings.
- Wallet UX depends on extension behavior and user approval flow.
- Some screenshots in README are desktop captures; mobile screenshots should be added for evaluator clarity.
- Pool balances are internal contract accounting credits, not native XLM/token custody transfers on-chain.
- **Trust Boundary & Settlement Proofs — closed.** `record_payment` now requires
  an ed25519 attestation from the settlement oracle, signed over the full claim
  (trip, expense, payer, member, amount, asset, tx hash, nonce, expiry) and
  verified inside the contract. Calling the contract directly with a fabricated
  `tx_hash` fails. The oracle verifies against Horizon server-side and treats the
  tx hash as a lookup key only. See `docs/DESIGN_ATTESTATION_ORACLE.md`.
- **Residual trust in the oracle key.** The design replaces a client-side check
  with a single server-held signing key. Anyone holding that key can mint proof
  of a payment that never happened. Mitigated by 5-minute attestation lifetimes,
  admin-held key rotation (`set_oracle_key`), and server-only custody; not
  eliminated. Threshold signing is the upgrade path.
- **Attestation ledger durability.** Without Supabase configured, the oracle's
  allocation ledger is process-local, so running multiple oracle instances would
  allow one payment to be over-allocated across expenses. The endpoint reports
  `durableLedger: false` when this is the case.
- **Multi-asset pool, single-asset settlement contract.** The pool holds balances
  keyed by `(member, token)` as of #145, so a settlement can no longer debit a
  balance in the wrong denomination — `record_payment` withdraws in the attested
  asset. The settlement contract still pins one settlement asset, because the
  attestation oracle signs claims for one asset; widening that is a separate
  change. See `docs/DESIGN_MULTI_ASSET_POOL.md`.
- **Pool balances migrate lazily.** A member's v1 balance is re-keyed on first
  touch rather than by a sweep, because a Soroban contract cannot enumerate its
  own storage keys. Nothing is lost in the interim — every read migrates before
  it answers — but a member's v2 entry does not exist until something touches
  them. `scripts/migrate-pool.sh` migrates known members eagerly.
- **TTL-archived balances are recorded, not restored.** If a v1 balance entry is
  archived before migration, the migration records zero and marks the member so a
  late restore cannot double-credit. Restoring archived ledger state is outside
  the contract's reach.
- **The pool's supported-asset list is admin-controlled.** A compromised admin
  could add a worthless token. This is the same trust already placed in the admin
  by `set_settlement_contract`.
- **Path payments settle debts in assets the payer does not hold** (#146). The
  payer spends what they have; the recipient receives exactly what is owed, via
  the Stellar DEX. Verification accepts both `payment` and
  `path_payment_strict_receive`, asserting on the destination asset and received
  amount. See `docs/DESIGN_PATH_PAYMENTS.md`.
- **Price impact is measured relative to the best route found, not absolutely.**
  With only one route available it reads 0 regardless of how poor that route is.
  An independent reference rate (seam S4) is now provided by `lib/fx/rateService.ts`
  via CoinGecko and ExchangeRate.host; see `docs/DESIGN_FX_RATES.md`.
- **Path quotes expire after 30 seconds and must be refreshed manually.** A book
  can move past the slippage tolerance inside that window; the consequence is a
  failed transaction rather than an overspend, but the payer must retry.
- **Users with no funded account can be onboarded via sponsored reserves**
  (#147). The sponsor pays the base reserve and the trustline reserve; the
  invitee signs the transaction themselves, so their keys never leave their
  wallet and the server cannot create an account they do not control. See
  `docs/DESIGN_ACCOUNT_ONBOARDING.md`.
- **Sponsorship exposure is capped, and the cap is per-process without Supabase.**
  Total locked reserve is bounded by `SPONSORSHIP_CAP_STROOPS`. With no durable
  ledger configured that cap applies per server instance, so a multi-instance
  deployment would permit N times the intended exposure. The capacity endpoint
  reports `durableLedger: false` when this is the case.
- **A dormant sponsored account can hold its reserve indefinitely.** Revocation
  requires the account to cover its own reserve; if it never does, the operation
  fails and the sponsorship stands. This is the deliberate cost of never taking
  funds from a user, and it means reclamation is best-effort.
- **Abuse resistance bounds but does not prevent capacity exhaustion.** An
  attacker with real XLM across several funded wallets can still consume
  sponsorship capacity. The damage is bounded to denial of *sponsored*
  onboarding — self-funding remains available throughout.

## Operational Constraints

- Any contract redeployment changes contract ID and requires env + README updates.
- Incorrect wallet/account setup can block end-to-end payment tests.
- Supabase configuration errors can affect sync behavior even if chain operations work.

## Recommended Future Improvements

- Extend Playwright coverage to authenticated flows (creating expenses, trip
  detail with real data, QR display) - the current suite covers landing,
  auth prompt, dashboard, expenses, trips, and trip detail pages plus mobile
  viewports, but only the unauthenticated/guard state, since there is no
  wallet-signing mock yet. See `docs/RUNBOOK.md` for how to run the suite.
- Add a script to validate README proof links are live.
- Add an automated checklist CI job that verifies required docs/sections exist.
- Introduce token/native-asset backed pool settlement model (transfer in/out) for stronger economic guarantees.
- Move the attestation oracle from a single signing key to threshold (M-of-N) signing, removing the single point of trust.
