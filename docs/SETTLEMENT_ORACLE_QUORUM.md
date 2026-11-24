# Settlement oracle quorum operations

The settlement contract v3 stores a unique signer set and an M-of-N threshold.
Every signature is verified against the complete domain-separated XDR claim,
which includes the contract address, payment parties, asset, amount, transaction,
nonce, and expiry. The contract rejects duplicate configured keys, duplicate
votes, expired claims, replayed nonces, and fewer than M valid votes.

## Signer custody and availability

Production should configure `SETTLEMENT_ORACLE_SIGNERS` as JSON entries of the
form `[{"url":"https://signer-a.example/sign","token":"…","publicKey":"G…"}, …]`.
Each endpoint receives `POST {"message":"<base64 claim bytes>"}` with its own
bearer token and returns `{ "signature":"<128 hex chars>", "publicKey":"G…" }`.
The application verifies each response before counting it. Place signer
endpoints in separately administered custody and hosting domains. A timeout or
bad response counts as an unavailable vote; if fewer than M respond, the
attestation API returns unavailable and settlement stays off-chain until retry.
No signing secret is sent to or bundled with a browser.

`SETTLEMENT_ORACLE_SECRETS` is supported for local development only. It accepts
distinct comma-separated Stellar seeds and must never be used as a production
substitute for independent signer custody. Set `SETTLEMENT_ORACLE_THRESHOLD`
(default 2) and matching `NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEYS` plus
`NEXT_PUBLIC_SETTLEMENT_ORACLE_THRESHOLD` for client-side preflight checks.

## Add, remove, and rotate

1. Generate a new key in its own signer custody domain and verify its public key
   out of band. Never send the seed to the app client.
2. An authorized contract admin calls `set_oracle_signers` with the union of
   old and new keys. Choose a temporary threshold that both the old quorum and
   the new quorum can meet (for example, 2-of-5 during a 2-of-3 to 2-of-3
   transition with two shared operators).
3. Update the attestation service's signer endpoint list and client public-key
   allowlist. Keep old and new domains online until both sides report healthy.
4. After the overlap window, call `set_oracle_signers` again with only the new
   set and its final threshold. This removes compromised or retired keys from
   contract verification immediately; no signature from a removed key counts.
5. For a compromised key, remove it promptly and choose a threshold that the
   remaining trusted signers can meet. If that is impossible, stop attestations
   and run the documented contract-admin recovery process; never lower the
   threshold to accept a compromised signer.

The admin account is the recovery authority. Protect it with the project's
governance process and a separately controlled multisignature Stellar account.
An unrecoverable signer outage safely disables authoritative on-chain recording;
it does not fabricate a quorum or a successful settlement record.

## Upgrade note

Contract v3 changes `init` and the `Attestation` XDR shape. Deploy a fresh v3
contract with a 2-of-3-or-stronger signer set, point the app at the new contract,
and keep the prior deployment read-only for historical lookups. Do not attempt
to reinterpret v2 single-key storage as a quorum configuration.
