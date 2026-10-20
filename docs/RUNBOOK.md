# Stellar-star Production Runbook

## 1. Prerequisites

- Node.js 18+
- npm 9+
- Rust toolchain (for contract work)
- Stellar CLI (for deployment operations)
- Funded Stellar testnet account
- Supabase project with schema from `supabase-setup.sql`

## 2. Environment Setup

Copy `.env.local.example` to `.env.local`:

```bash
cp .env.local.example .env.local
```

Ensure the following variables are configured:

- `NEXT_PUBLIC_STELLAR_NETWORK=TESTNET`
- `NEXT_PUBLIC_HORIZON_URL` (Horizon API URL)
- `NEXT_PUBLIC_STELLAR_EXPLORER` (Stellar Expert/Explorer URL)
- `NEXT_PUBLIC_SOROBAN_RPC_URL` (Soroban RPC URL)
- `NEXT_PUBLIC_CONTRACT_ID` (Deployed Soroban contract ID)
- `NEXT_PUBLIC_SUPABASE_URL` (Supabase Project URL)
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase Anonymous Client Key)
- `SUPABASE_JWT_SECRET` (or `JWT_SECRET` matching the Supabase JWT signing secret)
- `NEXT_PUBLIC_APP_NAME` (App metadata name)
- `NEXT_PUBLIC_APP_VERSION` (App version)
- `NEXT_PUBLIC_SITE_URL` (Deployment or localhost URL)

## 3. Local Validation

Run in project root:

- `npm run lint`
- `npm test -- --runInBand`
- `npm run build`

Run contract tests:

- `cd contract && cargo test`

### 3.1 End-to-End Tests (Playwright)

Browser-level coverage for the main user journeys (landing, auth prompt,
dashboard, expenses, trips, trip detail, plus mobile viewports) lives in
`e2e/e2e.spec.ts`. Playwright starts the Next.js dev server itself, so no
manual `npm run dev` step is needed first.

- `npm run test:e2e` - headless run across all configured projects (desktop
  Chrome/Firefox/Safari plus Mobile Chrome/Mobile Safari device emulation)
- `npm run test:e2e:ui` - interactive UI mode for debugging a single test
- `npx playwright test --project=chromium` - fastest single-browser run
  (what CI runs)
- `npm run test:e2e:report` - open the HTML report from the last run

No real Supabase project or wallet extension is required to run this suite:
it only asserts unauthenticated-state UI (wallet-connect prompts, auth
guards, page structure) and responsive layout, using the placeholder
Supabase env vars already set in `playwright.config.ts`'s `webServer`.

## 4. Contract Deployment (Testnet)

Run the automated contract deployment script:

```bash
bash scripts/deploy-contract.sh <secret-key-or-stellar-cli-alias> <token-contract-id>
```

This script will:
1. Build the WASM contract package (`settlex_contract.wasm`).
2. Resolve the deployer's public key address (`G...`).
3. Deploy the Settlement Pool contract instance and get its `POOL_CONTRACT_ID`.
4. Deploy the Settlement contract instance and get its `SETTLEMENT_CONTRACT_ID`.
5. Cross-initialize both contracts by calling `init_pool` with the settlement and token contract IDs, then `init` on the settlement contract (referencing the pool contract).
6. Print the contract IDs and Stellar Expert explorer links.

After deployment:
1. Update `NEXT_PUBLIC_CONTRACT_ID` and `NEXT_PUBLIC_SETTLEMENT_CONTRACT_ID` with the printed settlement contract ID.
2. Update `NEXT_PUBLIC_POOL_CONTRACT_ID` and `NEXT_PUBLIC_POOL_TOKEN_ID` with the printed values.
3. Save the printed explorer links in `README.md` and documentation if needed.

## 5. CI/CD Verification

- Ensure workflow files exist and are valid:
  - `.github/workflows/ci.yml`
  - `.github/workflows/production-check.yml`
- Validate network configuration:
  - Development / Testnet validation: `npm run config:validate`
  - Mandatory production deployment gate: `npm run config:validate -- --production`
    - Validates selected network, Horizon, Soroban RPC, explorer, contract IDs, asset issuer values, and public app URL without printing secrets.
    - Rejects testnet endpoints or placeholder contract IDs before production deployment.
- Confirm CI badge resolves in README.
- Confirm repo settings enforce checks on PRs (manual GitHub setting).

## 6. Release Documentation Pack

Before submission or mainnet promotion, verify:

- README is up to date
- `docs/MAINNET_READINESS.md` signed off and Go/No-Go gate evaluated
- `docs/RELEASE_CHECKLIST.md` current
- `docs/REQUIREMENT_PROOF_MATRIX.md` current
- `docs/ARCHITECTURE_AND_LIMITATIONS.md` current
- `docs/RUNBOOK.md` (specifically Section 9 Release Governance) reviewed

## 7. Incident / Rollback Basics

If a production or production-like issue occurs:

1. **Pause immediately**: Exercise pause authority (Section 9.2) to halt active releases or traffic.
2. Stop deployment changes and freeze configuration.
3. Re-run lint/test/build and contract tests.
4. Validate `.env.local` contract ID and network configuration consistency.
5. Compare README proof IDs/tx hashes against Stellar Expert explorer.
6. If contract ID is wrong or unrecoverable, follow the formal rollback procedure in Section 9.3.

## 8. Settlement Pool Credit Model

To prevent recording settlements without a valid proof on-chain, the Stellar-star contract interfaces with a `SettlementPoolContract`.
Before a payment record is accepted:
1. The user's share amount is checked against their balance in the pool contract.
2. If the user's pool balance is insufficient (shortfall > 0), they must deposit credits first using the "Deposit Shortfall" flow in their row. This invokes `deposit(member, amount)` on the pool contract with their signature.
3. When the payment is recorded via `record_payment`, the settlement contract performs an inter-contract call to the pool contract to `withdraw` the amount from the payer's pool balance.

## 9. Supabase Backup, Disaster Recovery & Customer Incident Communications

This section defines the operational procedures for database backup, retention, staging rebuilds, disaster recovery drills, recovery objectives, and customer-facing incident communications (Issue #308).

### 9.1 Backup Policy & Cryptographic Controls

- **Encryption**: All database backups are encrypted client-side using **AES-256-GCM** prior to export or storage.
- **Key Storage**: The 256-bit encryption key (`BACKUP_ENCRYPTION_KEY`) is stored in an isolated secret management system (e.g. AWS/GCP Secrets Manager), separate from operational database credentials.
- **Automated Backup Command**:
  ```bash
  npm run db:backup
  ```
- **Integrity Verification**:
  ```bash
  node scripts/backup-supabase.mjs --verify <backup-file.enc.json>
  ```
- **Retention Tiers**:
  - Daily snapshots: Retained 30 days.
  - Weekly snapshots: Retained 90 days.
  - Monthly archives: Retained 365 days.
  - Point-in-time recovery (PITR) WAL logs: Retained 7 days continuous.
- **Access Controls**:
  - Least-privilege IAM restricted to designated Disaster Recovery Engineers.
  - Multi-Factor Authentication (MFA) required for backup access and encryption key retrieval.
  - Immutable audit logging on all backup access and decryption operations.

### 9.2 Staging Rebuild & Schema Provisioning

To rebuild a clean staging or recovery environment from migration files and configuration:
```bash
npm run db:staging:rebuild
```
1. Verifies sequential ordering and checksums of all migration files in `migrations/`.
2. Validates cumulative schema and Row Level Security (RLS) policies in `supabase-setup.sql`.
3. Asserts deterministic trigger pipeline (`trg_01` to `trg_04`) on `public.expenses`.
4. Checks staging environment configuration against `.env.local.example`.

### 9.3 Recovery Rehearsal Drill

To rehearse disaster recovery and prove data recovery fidelity:
```bash
npm run db:drill
```
The drill executes an end-to-end recovery sequence on a canonical production slice:
1. Exports and encrypts a sampled trip, multi-version expense history (with payment hashes), trip invitation, and settlement intent.
2. Decrypts and reconstitutes the database state.
3. Asserts deep equality, member list integrity, share balances, and transaction proof preservation.
4. Asserts cross-referential integrity across relational foreign keys.
5. Verifies tamper resistance (mutated ciphertext fails GCM authentication tag validation).
6. Measures simulated Recovery Time Objective (RTO).

### 9.4 Recovery Objectives (RPO & RTO)

| Metric | Target | Rationale & Procedure |
|--------|--------|-----------------------|
| **Database RPO** | $\le 1$ hour | Automated snapshots every hour; $\le 5$ minutes with continuous PITR WAL streaming. |
| **On-Chain RPO** | **0 seconds** | All financial payments and Soroban contract attestations are permanently recorded on the Stellar ledger. Following database restoration, `lib/settlement/reconcile.ts` restores any in-flight settlement intents directly from blockchain truth. |
| **Target RTO** | $\le 30$ minutes | Full restoration from disaster declaration to staging/production recovery, integrity validation, and traffic cutover. |

### 9.5 Customer-Facing Incident Communication Templates

In the event of an unscheduled outage requiring database recovery, the on-call team utilizes the following pre-approved communication templates.

#### Phase 1: Initial Outage Notification (< 15 Minutes)

> **Headline:** Stellar-star Service Degradation & Maintenance
>
> **Status:** Investigating
>
> **Customer Message:**
> We are currently investigating an issue impacting access to trip and expense history. During this time, creating new expenses and signing settlements are temporarily paused.
>
> **Important Note on User Funds:**
> All settled payments and wallet balances are stored directly on the Stellar blockchain and remain completely safe and untouched. No funds are at risk.
>
> Our engineering team is actively working on restoring full service. Next update in 30 minutes.

#### Phase 2: Restoration In Progress (T + 30 Minutes)

> **Headline:** Database Maintenance and Data Restoration in Progress
>
> **Status:** Identified & Restoring
>
> **Customer Message:**
> We have identified a database service disruption and have initiated our automated recovery process.
>
> **Progress:**
> - Secure, encrypted database backups have been verified.
> - Data restoration to our standby environment is underway.
> - On-chain transaction state on the Stellar network is intact.
>
> We anticipate completing restoration and running consistency checks within the next 20 minutes. Next update at [Insert Time UTC].

#### Phase 3: Service Restored & Reconciled (T + 45 Minutes)

> **Headline:** All Systems Operational — Data Synchronized
>
> **Status:** Resolved
>
> **Customer Message:**
> Database services have been fully restored and verified.
>
> **What Was Done:**
> - Database state was restored from our latest authenticated backup.
> - Automated reconciliation verified all recent settlements against the Stellar blockchain to ensure 100% accuracy.
> - Trip memberships, expenses, and invitation links are fully accessible.
>
> If you notice any discrepancy or require assistance, please contact our support team with your wallet address or request ID. Thank you for your patience.

#### Phase 4: Post-Incident Review (PIR) Notice (Within 48 Hours)

> **Headline:** Post-Incident Review (PIR): Incident Reference [INC-XXXX]
>
> **Summary:**
> On [Date], between [Start Time UTC] and [End Time UTC], Stellar-star experienced a database service disruption lasting [X] minutes.
>
> **Impact:**
> Users were unable to access trip details or record new expenses. No on-chain funds or private keys were compromised or impacted.
>
> **Recovery Actions Taken:**
> - Automated disaster recovery runbook invoked.
> - Encrypted backup decrypted and restored within [X] minutes (achieving RTO target).
> - On-chain reconciliation synchronized in-flight settlement intents without data loss.

