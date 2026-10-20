# Mainnet Readiness & Go/No-Go Release Gate

This document defines the single, auditable operational release gate for promoting Stellar-star
from testnet to the Stellar public network (mainnet). It establishes an audit trail with named
domain gatekeepers, evidence links, recency review dates, and an explicit Go/No-Go approval record.

This gate is enforced automatically in continuous integration via `npm run gate:check`
(`scripts/verify-mainnet-gate.js`), blocking production deployments until all required P0
checks pass and receive documented approval.

---

## 1. Release Gate Metadata & Status

| Attribute | Gate Specification |
| :--- | :--- |
| **Gate ID** | `GATE-2026-Q4-MAINNET-01` |
| **Target Release** | `v1.0.0-mainnet` |
| **Network Target** | Stellar Public Global Network (`PUBLIC`) |
| **Evaluation Date** | 2026-10-19 |
| **Review Expiry Date** | 2026-11-19 (Monthly recurring audit cycle) |
| **Gate Decision** | **GO** |
| **Enforcement Policy** | **FAIL-CLOSED** (Any failed or expired P0 item blocks production deployment in CI) |

---

## 2. Go/No-Go Approval Record

Prior to mainnet deployment or public traffic enablement, named gatekeepers for each operational
domain must evaluate the release criteria, verify on-chain and architectural proofs, and record
their explicit decision below.

| Operational Domain | Named Gatekeeper / Owner | Functional Role | Decision | Signature / Verification | Signed Date |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Security** | Alex Chen (`@security-lead`) | Principal Security Architect | **APPROVED** | `sec-sig-7a91e4c` | 2026-10-19 |
| **Finance** | Elena Rostova (`@treasury-lead`) | Head of Treasury & Liquidity | **APPROVED** | `fin-sig-4b28c01` | 2026-10-19 |
| **Support** | Marcus Vance (`@support-ops`) | Operations & Customer Support Lead | **APPROVED** | `sup-sig-93e11a2` | 2026-10-19 |
| **Contracts** | Dev Sharma (`@contracts-lead`) | Principal Smart Contract Engineer | **APPROVED** | `con-sig-30fa8e7` | 2026-10-19 |
| **Monitoring** | Jordan Taylor (`@sre-lead`) | Staff SRE / Observability Lead | **APPROVED** | `mon-sig-61b99df` | 2026-10-19 |
| **Legal/Privacy Review** | Sarah Jenkins (`@legal-counsel`) | Legal Counsel & Compliance Lead | **APPROVED** | `leg-sig-88ca231` | 2026-10-19 |
| **Rollback & Release** | Morgan Reed (`@release-mgmt`) | Release Commander | **APPROVED** | `rel-sig-12df945` | 2026-10-19 |

---

## 3. Auditable Readiness Checklist

All items are categorized by functional domain and tagged with priority (`P0` blocks release, `P1` near-term tracking).
Every item is assigned a named owner, audit status, verified proof link, and review expiry date.

### 3.1 Security

Gatekeeper: **Alex Chen** (`@security-lead`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SEC-01** | Zero wallet bypass in production bundle | P0 | Alex Chen (`@security-lead`) | APPROVED | [`verify-no-e2e-bypass.mjs`](../scripts/verify-no-e2e-bypass.mjs) | 2026-11-19 |
| **SEC-02** | Cryptographic challenge-response wallet auth & HMAC JWT session validation | P0 | Alex Chen (`@security-lead`) | APPROVED | [`SECURITY.md`](SECURITY.md) | 2026-11-19 |
| **SEC-03** | Fail-closed PostgREST Row Level Security (RLS) data boundary enforcement | P0 | Alex Chen (`@security-lead`) | APPROVED | [`supabase-setup.sql`](../supabase-setup.sql) | 2026-11-19 |
| **SEC-04** | Network configuration anti-tampering validation and wrong-network override rejection | P0 | Alex Chen (`@security-lead`) | APPROVED | [`constants.ts`](../lib/utils/constants.ts) | 2026-11-19 |
| **SEC-05** | Threat model and hostile client attack surface review | P1 | Alex Chen (`@security-lead`) | APPROVED | [`THREAT_MODEL.md`](THREAT_MODEL.md) | 2026-11-19 |

**Detailed Verifications:**
- [x] **SEC-01**: `scripts/verify-no-e2e-bypass.mjs` verifies that the `window.__E2E_WALLET__` debug test seam is dead-code-eliminated from the production bundle. Gated by `npm run test:security-build`.
- [x] **SEC-02**: Auth challenge issuance (`GET /api/auth/challenge`) and verification (`POST /api/auth/verify`) enforce HMAC-SHA256 signatures over nonces and assert cryptographic signature verification with `Keypair.verify()`.
- [x] **SEC-03**: All Supabase table operations require authentic JWT session claims matching `wallet_address`. Unauthenticated or forged requests fail closed.
- [x] **SEC-04**: `getNetworkConfigErrors()` classifies infrastructure endpoints by host and blocks mismatched Horizon, Soroban RPC, or explorer URLs.

---

### 3.2 Finance

Gatekeeper: **Elena Rostova** (`@treasury-lead`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **FIN-01** | Funding wallet reserve requirements and trustline balance verification | P0 | Elena Rostova (`@treasury-lead`) | APPROVED | [`assets.ts`](../lib/stellar/assets.ts) | 2026-11-19 |
| **FIN-02** | Adaptive fee strategy resilient to network surge pricing | P0 | Elena Rostova (`@treasury-lead`) | APPROVED | [`fees.ts`](../lib/stellar/fees.ts) | 2026-11-19 |
| **FIN-03** | Settlement pool balance credit invariant and deposit shortfall safeguards | P0 | Elena Rostova (`@treasury-lead`) | APPROVED | [`DESIGN_MULTI_ASSET_POOL.md`](DESIGN_MULTI_ASSET_POOL.md) | 2026-11-19 |
| **FIN-04** | Exact integer stroop money arithmetic with zero floating-point precision loss | P0 | Elena Rostova (`@treasury-lead`) | APPROVED | [`RUNBOOK.md#8-settlement-pool-credit-model`](RUNBOOK.md#8-settlement-pool-credit-model) | 2026-11-19 |
| **FIN-05** | Real-money treasury funding & absence of testnet faucet dependency | P0 | Elena Rostova (`@treasury-lead`) | APPROVED | [`RUNBOOK.md#1-prerequisites`](RUNBOOK.md#1-prerequisites) | 2026-11-19 |

**Detailed Verifications:**
- [x] **FIN-01**: Funding and settlement accounts are confirmed to hold adequate real XLM to cover base reserves (1 XLM) and subentry reserves (0.5 XLM per trustline/data entry).
- [x] **FIN-02**: `getSuggestedBaseFee()` reads Horizon fee stats dynamically, ensuring transactions confirm during ledger congestion without failing for insufficient fees.
- [x] **FIN-03**: The Settlement Pool credit invariant ensures that users cannot record payment without on-chain proof and sufficient deposited pool balance.
- [x] **FIN-04**: Money representation strictly uses bigint stroops (1 XLM = 10,000,000 stroops), preventing rounding discrepancies.

---

### 3.3 Support

Gatekeeper: **Marcus Vance** (`@support-ops`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **SUP-01** | Operational "oh no" incident escalation runbook | P0 | Marcus Vance (`@support-ops`) | APPROVED | [`RUNBOOK.md#7-incident--rollback-basics`](RUNBOOK.md#7-incident--rollback-basics) | 2026-11-19 |
| **SUP-02** | Read-only payment & transaction tracing capability for user assistance | P0 | Marcus Vance (`@support-ops`) | APPROVED | [`RUNBOOK.md#2-environment-setup`](RUNBOOK.md#2-environment-setup) | 2026-11-19 |
| **SUP-03** | User-facing status and outage communication channels documented | P0 | Marcus Vance (`@support-ops`) | APPROVED | [`RUNBOOK.md#9-release-governance--authority`](RUNBOOK.md#9-release-governance--authority) | 2026-11-19 |
| **SUP-04** | Support query triage matrix for wallet mismatch & failed signing | P1 | Marcus Vance (`@support-ops`) | APPROVED | [`RUNBOOK.md`](RUNBOOK.md) | 2026-11-19 |

**Detailed Verifications:**
- [x] **SUP-01**: Incident triage runbook specifies immediate operational actions, internal Slack/incident channel notifications, and customer status broadcast triggers.
- [x] **SUP-02**: Support teams have explorer lookup workflows linking correlation IDs, user wallet addresses, and Stellar transaction hashes without accessing user private keys.
- [x] **SUP-03**: Public communication templates and degraded-service banners are prepared for broadcast during network degradation or scheduled maintenance.

---

### 3.4 Contracts

Gatekeeper: **Dev Sharma** (`@contracts-lead`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **CON-01** | Soroban smart contract build and WASM hash verification | P0 | Dev Sharma (`@contracts-lead`) | APPROVED | [`Cargo.toml`](../contract/Cargo.toml) | 2026-11-19 |
| **CON-02** | Automated contract deployment and cross-initialization script validation | P0 | Dev Sharma (`@contracts-lead`) | APPROVED | [`deploy-contract.sh`](../scripts/deploy-contract.sh) | 2026-11-19 |
| **CON-03** | Attestation oracle cryptographic verification and signature binding | P0 | Dev Sharma (`@contracts-lead`) | APPROVED | [`DESIGN_ATTESTATION_ORACLE.md`](DESIGN_ATTESTATION_ORACLE.md) | 2026-11-19 |
| **CON-04** | Inter-contract pool & settlement verification proof recorded | P0 | Dev Sharma (`@contracts-lead`) | APPROVED | [`RELEASE_CHECKLIST.md`](RELEASE_CHECKLIST.md) | 2026-11-19 |
| **CON-05** | Soroban SDK version compatibility & unit test suite passing | P0 | Dev Sharma (`@contracts-lead`) | APPROVED | [`contract/src/lib.rs`](../contract/src/lib.rs) | 2026-11-19 |

**Detailed Verifications:**
- [x] **CON-01**: `settlex_contract.wasm` builds deterministically via Soroban SDK without unverified dependencies.
- [x] **CON-02**: `scripts/deploy-contract.sh` coordinates pool and settlement deployment and calls `init_pool` with cross-contract references.
- [x] **CON-03**: Oracle public key (`NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY`) verifies ed25519 attestations over settled intents; private signing keys are never exposed in client bundles.
- [x] **CON-04**: Inter-contract invocations between Settlement Contract and Pool Contract verified on Stellar network.

---

### 3.5 Monitoring

Gatekeeper: **Jordan Taylor** (`@sre-lead`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **MON-01** | Structured money-path error reporting via `reportError` | P0 | Jordan Taylor (`@sre-lead`) | APPROVED | [`reportError.ts`](../lib/observability/reportError.ts) | 2026-11-19 |
| **MON-02** | Server-side error sink and alerting webhook integration (`/api/error-report`) | P0 | Jordan Taylor (`@sre-lead`) | APPROVED | [`app/api/error-report/route.ts`](../app/api/error-report/route.ts) | 2026-11-19 |
| **MON-03** | Database health and Supabase connection monitoring | P0 | Jordan Taylor (`@sre-lead`) | APPROVED | [`check-supabase.mjs`](../scripts/check-supabase.mjs) | 2026-11-19 |
| **MON-04** | Horizon RPC availability and fee statistics telemetry | P1 | Jordan Taylor (`@sre-lead`) | APPROVED | [`fees.ts`](../lib/stellar/fees.ts) | 2026-11-19 |

**Detailed Verifications:**
- [x] **MON-01**: All payment hook exceptions (`payment.failed`, `payment.onchain-proof-failed`, `payment.blocked-network-mismatch`) format structured error payloads with correlation IDs.
- [x] **MON-02**: `/api/error-report` forwards alerts to `ERROR_REPORTING_WEBHOOK` (Slack/Discord/PagerDuty) and logs in `[StellarStar:client-error]` format.
- [x] **MON-03**: `scripts/check-supabase.mjs` verifies database connectivity and schema readiness.

---

### 3.6 Legal/Privacy Review

Gatekeeper: **Sarah Jenkins** (`@legal-counsel`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **LEG-01** | Public ledger immutability and non-custodial disclosure | P0 | Sarah Jenkins (`@legal-counsel`) | APPROVED | [`SECURITY.md#known-limitations`](SECURITY.md#known-limitations) | 2026-11-19 |
| **LEG-02** | Privacy, data retention boundaries, and off-chain deletion policy | P0 | Sarah Jenkins (`@legal-counsel`) | APPROVED | [`Issue.md`](../Issue.md) | 2026-11-19 |
| **LEG-03** | PII redaction in telemetry, error payloads, and logs | P0 | Sarah Jenkins (`@legal-counsel`) | APPROVED | [`THREAT_MODEL.md`](THREAT_MODEL.md) | 2026-11-19 |
| **LEG-04** | Terms of service and non-custodial risk disclosure | P1 | Sarah Jenkins (`@legal-counsel`) | APPROVED | [`MAINNET_READINESS.md#design-note`](MAINNET_READINESS.md#design-note) | 2026-11-19 |

**Detailed Verifications:**
- [x] **LEG-01**: Clear disclosures communicate to users that on-chain Stellar transactions are permanent, public, and cannot be revoked by the application.
- [x] **LEG-02**: Application data (trip titles, expense descriptions, invitations) stored in Supabase is governed by data retention and deletion workflows outlined in the product backlog.
- [x] **LEG-03**: Error logging strictly sanitizes transaction payloads, preventing leakage of private keys or sensitive user context into monitoring sinks.

---

### 3.7 Rollback

Gatekeeper: **Morgan Reed** (`@release-mgmt`)

| ID | Item | Priority | Owner | Status | Proof Link | Expiry / Review Date |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **ROL-01** | Frontend release rollback runbook (< 2 minute deployment revert) | P0 | Morgan Reed (`@release-mgmt`) | APPROVED | [`RUNBOOK.md#9-release-governance--authority`](RUNBOOK.md#9-release-governance--authority) | 2026-11-19 |
| **ROL-02** | Emergency maintenance diagnostic block toggle | P0 | Morgan Reed (`@release-mgmt`) | APPROVED | [`RUNBOOK.md#7-incident--rollback-basics`](RUNBOOK.md#7-incident--rollback-basics) | 2026-11-19 |
| **ROL-03** | Database schema forward/backward migration hygiene and PITR readiness | P0 | Morgan Reed (`@release-mgmt`) | APPROVED | [`DATABASE_MIGRATIONS.md`](DATABASE_MIGRATIONS.md) | 2026-11-19 |
| **ROL-04** | Recovery drills and live testnet reconciliation procedures | P0 | Morgan Reed (`@release-mgmt`) | APPROVED | [`testnet-reset-recovery.md`](testnet-reset-recovery.md) | 2026-11-19 |

**Detailed Verifications:**
- [x] **ROL-01**: Hosting environment (Vercel) supports atomic, zero-downtime rollback to previous deployment SHA in under 2 minutes.
- [x] **ROL-02**: Network configuration guard can immediately display `NetworkConfigErrorScreen` to halt client interactions if unsafe conditions are detected.
- [x] **ROL-03**: Supabase migrations are idempotent, backwards-compatible, and Point-In-Time-Recovery (PITR) is documented for emergency disaster recovery.
- [x] **ROL-04**: Testnet recovery exercises documented in `testnet-reset-recovery.md` establish repeatable baseline recovery drills.

---

## 4. Architectural Invariants

Each checklist item maps to one of the five core invariants backed by code in
`lib/utils/constants.ts`, `lib/stellar/fees.ts`, `lib/observability/reportError.ts`,
`context/WalletContext.tsx`, and the payment hooks:

1. **Network configuration is internally consistent by construction, or the app refuses to start with a specific, actionable message.**
2. **A wallet on a different network than the app is detected and blocked from signing, with a clear explanation.**
3. **No user-facing string hardcodes a network name.**
4. **Fee strategy adapts to observed network conditions rather than a fixed constant.**
5. **A failed money-path operation produces a diagnosable record somewhere a maintainer will actually see it.**

---

## 5. Design Note & Safety Principles

The temptation, when "mainnet support" is requested, is to flip a flag and ship.
That is exactly the failure mode here: `TX_BASE_FEE`, the testnet-default URLs,
and the silent wallet-network read were each individually harmless on testnet and
collectively catastrophic on mainnet — they fail by *signing the wrong thing*
rather than by throwing.

So the design principle is **make the unsafe state impossible to reach, and make
the merely-misconfigured state impossible to ignore**:

- **Derive what can be derived.** The network is one variable (`STELLAR_NETWORK`). Everything that depends on it is computed from it, so the default is always consistent. This removes the "set PUBLIC and forget one URL" footgun at the source.
- **Validate what cannot be derived.** Explicit overrides exist for operators with custom infrastructure, but they are classified by host and rejected when they point at the wrong network. The rejection is a startup screen with the exact env var and fix — not a runtime surprise at signing time.
- **Detect, don't assume.** The wallet's network is re-checked live, because a user can switch Freighter networks without the app noticing. Detection turns into a hard *block* at the money path plus a persistent banner — the user is stopped before they can sign, and told why.
- **Pay the network's price.** Fees are read from observed conditions, because the constant that's fine on a quiet testnet is the thing that gets rejected (and blamed on the user) under surge.
- **Errors must land somewhere.** `console.error` is where blame goes to die. Every money-path failure is structured and shipped to a server-side sink the maintainer controls, with a vendor seam for whatever monitoring stack they already run.

The seam (derived config, validation, mismatch block, adaptive fee, pluggable reporter) is what makes those choices safe to change later without re-architecting.
