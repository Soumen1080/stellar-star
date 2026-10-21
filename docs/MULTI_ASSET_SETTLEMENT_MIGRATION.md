# Multi-asset settlement contract: review and migration plan (#331)

## Current boundary

`contract/src/attest.rs` includes the asset contract address in the signed
claim, and `record_payment` compares it with the one `SettlementAsset` stored
at initialization. This prevents the existing contract from debiting a pool
balance in a different token. The pool supports asset keyed balances, but that
does not authorize the settlement contract to accept arbitrary assets.

The existing independent report in `docs/SECURITY_AUDIT_REPORT.md` predates
this proposed contract change. Its general asset-mismatch coverage is not a
review of an allowlist, a widened signed claim, issuer verification, or a
contract migration. No contract widening or redeployment is authorized by this
plan alone.

## Proposed claim identity (review required)

The claim must bind a canonical Stellar asset identity to the chain/network and
settlement contract. The current Soroban asset contract address is included in
the signature, but the vNext protocol should also carry the canonical identity
explicitly so every boundary can cross-check it:

- Native: `{ kind: "native", code: "XLM", issuer: null }`.
- Credit asset: `{ kind: "credit", code, issuer }`, where code and issuer are
  validated and the issuer is a valid Stellar account address.
- Bind the asset identity, derived Stellar Asset Contract address, network
  passphrase/domain, settlement contract, expense, payer, member, amount,
  nonce, and expiry in the oracle signature.
- The contract accepts only identities whose derived SAC matches the signed
  address and whose canonical identity is present in its administrator-managed
  allowlist. It must never trust the code alone or an arbitrary token contract.

The reviewer must confirm the SDK's deterministic asset-to-SAC derivation and
contract-side verification API for the pinned Soroban SDK before implementation.
If the contract cannot independently verify the mapping, the design must use a
reviewed registry contract that does so; a caller-provided code/issuer pair is
not proof that an arbitrary token address represents that asset.

## End-to-end enforcement

1. Network-specific asset registry allowlists contain native XLM and explicitly
   approved `(code, issuer)` pairs; testnet and public-network entries are
   independent.
2. The oracle validates the allowlist entry, issuer account, asset type, seven
   decimal classic Stellar precision, and Horizon operation asset fields before
   signing. Unknown or malicious issuers are rejected.
3. The app validates the canonical asset again before building payment XDR and
   checks the payer trustline and issuer authorization. A credit-asset payment
   without a valid destination trustline is blocked before signing.
4. The contract verifies the signed identity, SAC mapping, allowlist membership,
   amount bounds, nonce, and expiry before withdrawing from the exact
   `(member, asset)` pool balance.
5. Reconciliation stores and compares canonical asset identity in every layer;
   same-expense claims in different assets remain separate claims and separate
   pool debits.

## Migration and compatibility

Do not mutate or reinitialize the deployed v2 settlement contract in place.
Its storage and ABI are single-asset, and its existing `PaymentRecord` entries
must remain readable. Deploy a new contract version after review and testnet
verification. Keep the old contract configured as a historical reader; route
new proposals only to the new contract after an explicit operator cutover.

Pool balances remain keyed by `(member, token)` and are not transferred during
settlement-contract migration. Existing v2 payment records remain under the
old contract ID and are not copied or rewritten. The application must read both
contract IDs during the compatibility window and label each record with its
source contract/version. Deployment configuration must carry the old reader ID,
new writer ID, network, allowlist version, and cutover date. Rollback stops new
vNext claims and restores the old single-asset writer; it never deletes or
rewrites either history.

## Required review and release gates

- Independent reviewer signs off on the canonical identity encoding,
  domain separation, SAC derivation, allowlist administration, issuer policy,
  replay protection, and pool withdrawal authorization.
- Threat model tests include same expense in two assets, same asset code from
  two issuers, arbitrary token contract, altered code/issuer, wrong network,
  unauthorized issuer, missing trustline, wrong decimals, replay, and old
  single-asset contract records.
- Contract, oracle, UI, and reconciliation test suites pass on a clean local
  environment and Stellar testnet before public network cutover.
- Record reviewed source commit, WASM digest, contract IDs, migration rehearsal,
  operators, rollback evidence, and reviewer approval in the release record.

Until those gates are met, the settlement contract remains single-asset even
though the expense and pool models can represent multiple assets.
