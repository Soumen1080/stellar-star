# Security Model: Wallet Authentication & Data Access

## Problem this replaces

Earlier revisions of this project scoped Supabase Row Level Security (RLS)
policies to a client-supplied `x-wallet-address` header. Any client could set
that header to any value, so RLS was not actually enforcing wallet ownership
- it trusted a self-reported string.

## Current model: signed wallet challenge + verified JWT

Identity is established through a server-issued, cryptographically signed
challenge and never through a value the client merely asserts.

1. **Challenge issuance** - `GET /api/auth/challenge?address=<wallet>`
   (`app/api/auth/challenge/route.ts`) generates a random `nonce` and a 5
   minute `expiration`, then computes `signature = HMAC-SHA256(address:nonce:expiration)`
   keyed by `SUPABASE_JWT_SECRET`. This HMAC lets the verify step later
   confirm the nonce/expiration pair actually came from this server and was
   not forged or paired with a different address. The endpoint also builds
   an unsigned Stellar transaction (source = the claimed address, a single
   `manageData` operation named `"StellarStar Auth"` carrying the nonce as
   its value) and returns it as unsigned XDR alongside the nonce, expiration,
   and HMAC signature.

2. **Client signs, never submits** - the client signs the XDR with the
   connected wallet extension (`lib/freighter`'s `signXDR`) and posts the
   signed XDR back with the original nonce/expiration/signature. The
   transaction is a signature artifact only; it is never submitted to the
   Stellar network.

3. **Server verification** - `POST /api/auth/verify`
   (`app/api/auth/verify/route.ts`) rejects the request unless *all* of the
   following hold:
   - The HMAC signature matches (recomputed server-side, compared with
     `crypto.timingSafeEqual`) - proves the challenge was minted by this
     server.
   - `Date.now()` is before `expiration` - bounds the challenge lifetime.
   - The XDR parses as a standard (non fee-bump) transaction whose `source`
     equals the claimed `address`.
   - It contains exactly one operation, the expected `manageData("StellarStar Auth", nonce)`
     - binds the signature to this specific challenge, preventing reuse of a
     signature minted for a different session.
   - `Keypair.fromPublicKey(address).verify(tx.hash(), ...)` succeeds against
     at least one of the transaction's signatures - the actual proof that
     whoever holds the private key for `address` produced this signature.
     Wallets sign `tx.hash()` (the sha256 of the transaction's signature
     payload), not the payload itself, so verification must hash it the same
     way; checking against the unhashed payload would reject every
     legitimately signed challenge.
   - The issued nonce is consumed after successful signature verification, so
     it cannot mint a second session on the same warm server instance.


4. **Session token** - once verified, the server mints a standards-compliant
   HS256 JWT (`lib/supabase/serverAuth.ts#signSupabaseJwt`) with
   `aud: "authenticated"`, `role: "authenticated"`, `sub` (the user's row id,
   or the wallet address itself pre-signup), and a `wallet_address` claim,
   signed with `SUPABASE_JWT_SECRET` and expiring after 24 hours. The client
   stores it (`StellarStar:authToken` in localStorage) and sends it as
   `Authorization: Bearer <token>` on every Supabase request
   (`lib/supabase/client.ts#createAuthenticatedClient`).

5. **Database enforcement** - because the token is a genuine JWT signed with
   the same secret configured in the Supabase project's Auth settings,
   **PostgREST verifies the JWT signature itself** before RLS ever runs, and
   exposes the verified claims via `request.jwt.claims`. Every RLS policy in
   `supabase-setup.sql` reads identity as
   `current_setting('request.jwt.claims', true)::json->>'wallet_address'`.
   Nothing in the schema or policies reads a header. If the JWT signature is
   invalid or missing, PostgREST rejects the request before it reaches a
   policy at all (fail-closed).

## Key management

`SUPABASE_JWT_SECRET` (or `JWT_SECRET` as a fallback name) must be set to
**the same value as the Supabase project's JWT signing secret** (Project
Settings -> API -> JWT Secret), so that:
- the app can mint tokens PostgREST will accept, and
- nobody who can only read the app's env can also read Supabase's secret (they're the same value, kept out of source control).

`lib/supabase/serverAuth.ts` no longer has a hardcoded fallback secret - if
the env var is unset, challenge issuance and token minting throw immediately
instead of silently signing with a value that is public in this repository's
history. A misconfigured deployment fails loudly at request time rather than
producing forgeable session tokens.

## Migration path for existing deployments

Deployments still running the old header-trust policies must update the
database and application together, not incrementally:

1. Set `SUPABASE_JWT_SECRET` in the app's environment to the Supabase
   project's actual JWT secret, if not already set.
2. Re-run `supabase-setup.sql` in the Supabase SQL editor. It is idempotent:
   it drops the old policies by name and recreates the JWT-claim-based
   policies (`OPTION B` in the file). There is no header-based policy left to
   remove separately - it was never a distinct code path, just the same
   policy names now defined differently.
3. Deploy the updated application code (which sends `Authorization: Bearer
   <token>` rather than any wallet header) at the same time as step 2.
   Because RLS defaults to deny, an old client that only ever sent a header
   and never obtained a JWT will simply see empty results / rejected writes
   under the new policies - there is no fail-open window.
4. Existing users are unaffected at the data layer (`wallet_address` is
   still the identifying column); they simply need to complete the
   sign-in challenge once to obtain a valid session token.

## Known limitations

- Challenge/session secrets are a single shared `SUPABASE_JWT_SECRET`; there
  is no per-session asymmetric signing or key rotation mechanism.
- Sessions are bearer tokens with a 24 hour lifetime and no server-side
  revocation list; compromise of a token is valid until expiry.
- The single-use challenge registry is process-local. It prevents replay on a
  warm Vercel function instance, but a high-assurance multi-instance deployment
  should replace it with an atomic shared store (for example Redis or a
  server-only Supabase table) keyed by nonce.

## The hostile client and the E2E wallet seam (build boundary B4)

Stellar Star is non-custodial, so the **client is treated as hostile** (see
[`THREAT_MODEL.md`](./THREAT_MODEL.md)). A prior revision short-circuited the
wallet layer whenever `window.__E2E_WALLET__` was present, with no build guard —
meaning any script in the page (XSS, a malicious extension, a compromised
dependency) could impersonate a connected wallet in the UI. That bypass has been
removed (issue #162).

The replacement is a test-only seam in `lib/stellar/e2eWallet.ts`, gated solely
on the build-time flag `NEXT_PUBLIC_E2E_TEST_MODE`:

- In a normal production build the flag is unset, the guard folds to
  `return null`, and the `window.__E2E_WALLET__` read is dead-code-eliminated
  from the bundle. This is enforced by `scripts/verify-no-e2e-bypass.mjs`, which
  builds a clean production bundle and fails if the marker is present. The test
  (`__tests__/security/no-e2e-bypass.test.ts`) runs it.
- A deliberately built test bundle (`NEXT_PUBLIC_E2E_TEST_MODE=true next build`)
  keeps the seam so Playwright can drive the UI with a real keypair; such a
  bundle is a test artifact and must never be deployed. The deploy pipeline
  builds without the flag.

The server-side signature check in `POST /api/auth/verify` was never bypassed by
the old seam: it still requires a real signature over the server challenge, so
the seam could only impersonate *UI state*, not authenticate. That impersonation
primitive is what is now absent from production.
