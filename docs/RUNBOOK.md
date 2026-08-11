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
- Confirm CI badge resolves in README.
- Confirm repo settings enforce checks on PRs (manual GitHub setting).

## 6. Release Documentation Pack

Before submission, verify:

- README is up to date
- `docs/RELEASE_CHECKLIST.md` current
- `docs/REQUIREMENT_PROOF_MATRIX.md` current
- `docs/ARCHITECTURE_AND_LIMITATIONS.md` current

## 7. Incident / Rollback Basics

If production-like issue occurs:

1. Stop deployment changes.
2. Re-run lint/test/build and contract tests.
3. Validate `.env.local` contract ID.
4. Compare README proof IDs/tx hashes against explorer.
5. If contract ID is wrong, redeploy and update env + docs consistently.

## 8. Settlement Pool Credit Model

To prevent recording settlements without a valid proof on-chain, the Stellar-star contract interfaces with a `SettlementPoolContract`.
Before a payment record is accepted:
1. The user's share amount is checked against their balance in the pool contract.
2. If the user's pool balance is insufficient (shortfall > 0), they must deposit credits first using the "Deposit Shortfall" flow in their row. This invokes `deposit(member, amount)` on the pool contract with their signature.
3. When the payment is recorded via `record_payment`, the settlement contract performs an inter-contract call to the pool contract to `withdraw` the amount from the payer's pool balance.
