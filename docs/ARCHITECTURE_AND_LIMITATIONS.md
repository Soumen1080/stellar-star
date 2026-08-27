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
- **Single-asset settlement.** The contract compares the attested asset against
  one configured settlement asset for equality. Multi-asset pool routing is #43.

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
