# Threat Model — Stellar Star

> Stellar Star is a **non-custodial** group-expense app on Stellar. The server
> never holds keys, never holds funds, and never sees a user's secret. That
> single fact drives the whole model: **the client is hostile.** Any code that
> runs in the user's browser — first-party app code, a browser extension, an XSS
> payload, or a compromised dependency — is treated as untrusted and is assumed
> capable of arbitrary DOM, `localStorage`, network, and wallet-API access.
>
> This document enumerates the trust boundaries, the assets they protect, the
> concrete threats against a hostile client, and for each threat whether it is
> **mitigated**, **accepted** (with rationale), or **tracked** (open, with a
> remediation owner). It complements [`SECURITY.md`](./SECURITY.md), which
> describes the signed-challenge auth flow in detail.

## 1. Assets

| # | Asset | Why it matters |
|---|-------|----------------|
| A1 | Wallet **private key** | Controls signer's XLM and every escrow/settlement. Irrecoverable if leaked. |
| A2 | **Session JWT** (`StellarStar:authToken`) | Bearer token accepted by PostgREST; grants DB access scoped to `wallet_address`. |
| A3 | **Trip / expense data** | Group financial records; incorrect reads/writes cause real money movement via on-chain settlement. |
| A4 | **Server-side secrets** (`SUPABASE_JWT_SECRET`) | Used to mint JWTs and HMAC-sign challenges. Leak = full auth forgery. |
| A5 | **On-chain funds** in escrow/settlement contracts | Ultimately the thing being protected. |

## 2. Trust boundaries

Each boundary names what is trusted, by whom, and why. A request crossing a
boundary must be re-verified on the trusted side.

| # | Boundary | Trusted side | Untrusted side | What is trusted, by whom, why |
|---|----------|--------------|---------------|-------------------------------|
| B1 | **Browser ↔ Wallet extension** (Freighter/xBull/Lobstr) | Extension (holds A1) | App JS, page scripts | The extension is trusted to custody the key and to show the user a signing prompt before signing. The app only ever receives a *signed* transaction; it never sees A1. Trust is by design — non-custodial. |
| B2 | **App ↔ Server `/api/auth/*`** | Next.js route handlers | Client (hostile) | The server trusts **only** a cryptographic signature over its own challenge (see `SECURITY.md`). It does NOT trust any client-asserted address, token, or header. |
| B3 | **Client ↔ Supabase (PostgREST)** | Supabase + RLS | Client JWT (A2) | PostgREST verifies the JWT signature itself, then RLS trusts the **verified `wallet_address` claim** (`request.jwt.claims`). It trusts nothing the client sends in headers/body. |
| B4 | **App build ↔ Deployed bundle** | Build pipeline | `NEXT_PUBLIC_*` env at build time | A production bundle trusts only what was compiled into it. Any test-only code path must be **absent** from the bundle, not merely dormant (this is the bug fixed in #162). |
| B5 | **Server ↔ `SUPABASE_JWT_SECRET`** (A4) | Secret store / deploy env | Everyone else | The secret is trusted to mint challenges and JWTs. It must never be in source control or client bundle. |
| B6 | **App ↔ Stellar network / contracts** | On-chain logic | Client-submitted XDR | Settlement trusts the ledger, not the app. The app only *presents* XDR the wallet signed; the contract enforces correctness. |

## 3. Threats

### T1 — Cross-site scripting / arbitrary script execution in the page
**Actor:** attacker who achieved script execution (stored/reflected XSS, malicious
extension content script, or a compromised dependency — see T3).
**Capability at B1/B2/B3:** read `localStorage` (A2, public key), call any
first-party function, call the wallet extension API, fabricate network requests
to Supabase/API using the stolen JWT.
**What it CANNOT do:** forge a valid session JWT (needs A4) or produce a
signature over a server challenge without the user approving in the extension.

**Historical gap (now closed):** before #162, `lib/stellar/walletsKit.ts`
consulted `window.__E2E_WALLET__` on *every* call with no build guard. Any
script could set that global and make the app believe it was connected as an
arbitrary address — **UI-state impersonation with no extension and no user
approval.** That is exactly the primitive that turns a small XSS into a large
incident.

**Status: MITIGATED (post-#162) + ACCEPTED residual.**
- The seam is now gated solely behind `NEXT_PUBLIC_E2E_TEST_MODE` and is
  dead-code-eliminated from flag-less production bundles (verified by
  `scripts/verify-no-e2e-bypass.mjs`). An attacker setting `window.__E2E_WALLET__`
  in production has no effect.
- **Residual / accepted:** XSS can still read A2 from `localStorage` and replay
  it against Supabase until the 24h expiry. This is inherent to a non-custodial
  SPA that must send the JWT from the browser. Mitigations: short lifetime + no
  server-side revocation (documented limitation in `SECURITY.md`); defense-in-depth
  is a Content-Security-Policy (currently not enforced — **TRACKED**, see §5).

### T2 — Malicious group member
**Actor:** a wallet that is a legitimate participant in a trip/expense.
**Capability:** submit their own (validly signed) addresses; read rows their
wallet is authorised for; attempt to poison splits/amounts.
**What the architecture defends:** RLS scopes every query to the verified
`wallet_address` (B3), so a member cannot read or write rows outside trips they
participate in. Settlement requires each member's wallet to *sign* the actual
Stellar transaction (B1/B6) — a member cannot move another member's funds
without that member's key approving it.
**Status: MITIGATED**, with one open item: **group-membership authorization is
enforced at the app/RLS layer, not the ledger.** If a trip's participant list
can be mutated by a non-owner, a member could add a confederate address. This is
**TRACKED** (see §5) pending a review of trip-ownership RLS.

### T3 — Compromised dependency (supply-chain)
**Actor:** a malicious or hijacked npm package in the client bundle.
**Capability:** equivalent to T1 but persistent and silent — full DOM,
`localStorage`, network, and `window.freighter` access for every user.
**Status: MITIGATED (the specific #162 gap) + ACCEPTED residual.**
- A compromised dep can no longer flip the E2E seam (the path is gone from
  production — that was the realistic way a dep could impersonate identity).
- **Residual / accepted:** a compromised dep still has T1's capabilities.
  Mitigations are process-level: pinned lockfile, `npm ci` in CI, minimal
  dependency surface, and (TRACKED) Subresource Integrity / CSP. The accepted
  risk line sits at: *we defend the key and the signature, we do not attempt to
  guarantee the entire client bundle is uncompromised; that is the user's
  browser/extension environment.*

### T4 — Rogue / compromised wallet extension
**Actor:** a malicious or hijacked wallet extension the user installed.
**Capability:** sign arbitrary XDR if the user approves; exfiltrate A1 if
malicious.
**Status: ACCEPTED.** Non-custodial by definition means the extension is the
user's chosen custodian. Mitigation is UX: the app must always show the human
what they are signing (amount, counterparty, `manageData` nonce) — **TRACKED**
as a signing-clarity review, since a deceptive extension could still show
misleading text.

### T5 — Server / `SUPABASE_JWT_SECRET` compromise (A4)
**Actor:** attacker with the JWT secret.
**Capability:** mint arbitrary sessions for any `wallet_address` → full RLS
bypass (B3).
**Status: MITIGATED by construction.** `lib/supabase/serverAuth.ts` has no
hardcoded fallback and throws if the secret is unset (removed the
public-in-history default). Mitigation depends on secret hygiene (env-only,
out of source control) — **ACCEPTED** operational risk, documented in
`SECURITY.md`.

### T6 — Replay / challenge reuse
**Actor:** network observer or token thief.
**Capability:** reuse a signed challenge or session.
**Status: MITIGATED.** Challenges are single-use and 5-minute bounded
(`SECURITY.md`); sessions are bearer tokens with 24h expiry and no revocation
(**accepted** limitation, §1/T1 residual).

### T7 — MITM / transport
**Actor:** network position.
**Capability:** intercept or alter traffic.
**Status: MITIGATED** by `Strict-Transport-Security` (see `next.config.mjs`) and
TLS-only Supabase. **Accepted** residual: no certificate pinning.

## 4. Where the accepted-risk line sits

The architecture makes a deliberate, documented choice:

> **We guarantee the key (A1) and the signature are never in app control, and
> we guarantee no code path in a production bundle can impersonate a wallet.
> We do NOT guarantee the client runtime is free of attacker script — that is
> the user's browser. Against a hostile client we defend the ledger and the
> server, and we contain blast radius (short tokens, RLS scoping, on-chain
> signing) rather than attempting client-side secrecy.**

The #162 fix moves the E2E seam from "dormant but present in production" to
"absent from production," tightening B4 so the accepted-risk line no longer
includes a shipped impersonation primitive.

## 5. Tracked items (open)

| # | Item | Owner area | Intent |
|---|------|-----------|--------|
| K1 | Add a Content-Security-Policy (and SRI where feasible) to shrink the XSS blast radius (T1/T3). | `next.config.mjs` headers | Reduce T1/T3 residual. |
| K2 | Audit trip-ownership / participant-mutation RLS so a member cannot add confederate addresses (T2). | `supabase-setup.sql` | Close T2 gap. |
| K3 | Signing-clarity review: ensure every `signXDR` call shows amount + counterparty (T4). | wallet UI | Reduce T4 deception. |
| K4 | Keep `scripts/verify-no-e2e-bypass.mjs` in CI as a release gate (B4). | CI | Enforce #162 invariant. |

## 6. E2E test seam (B4) — design note

The Playwright suite needs a "connected wallet" without a real extension. The
seam lives **only** in `lib/stellar/e2eWallet.ts`, gated on the build-time flag
`NEXT_PUBLIC_E2E_TEST_MODE`:

- In a **normal production build** the flag is unset, so Next inlines `"false"`,
  the guard folds to `return null`, and the `window.__E2E_WALLET__` read is
  dead-code-eliminated. `scripts/verify-no-e2e-bypass.mjs` proves this.
- In a **test build** (`NEXT_PUBLIC_E2E_TEST_MODE=true next build && next start`)
  the seam is present and the Playwright `mockWallet()` helper drives the UI with
  a real keypair, exercising the server's signature verification for real. Such a
  build is a **test artifact and must never be deployed**.
- A build created this way is gated behind the flag precisely so the deploy
  pipeline — which builds *without* the flag — cannot ship the bypass.

This replaces the previous `window.__E2E_WALLET__`-only check (T1 historical
gap) that was reachable by any script in production.
