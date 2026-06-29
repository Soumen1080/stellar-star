# SettleX Production Runbook

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

## 4. Contract Deployment (Testnet)

Recommended flow:

1. Build contract via Stellar CLI tooling.
2. Run `./scripts/deploy-contract.sh <secret-key-or-alias>` to build, deploy, and initialize both settlement and pool contracts. The script prints settlement and pool contract IDs plus explorer links.
3. Execute one `record_payment` flow that triggers pool withdraw to prove inter-contract behavior.
4. Update `NEXT_PUBLIC_CONTRACT_ID` with settlement contract ID.
5. Save all explorer links in README/docs.

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

To prevent recording settlements without a valid proof on-chain, the SettleX contract interfaces with a `SettlementPoolContract`.
Before a payment record is accepted:
1. The user's share amount is checked against their balance in the pool contract.
2. If the user's pool balance is insufficient (shortfall > 0), they must deposit credits first using the "Deposit Shortfall" flow in their row. This invokes `deposit(member, amount)` on the pool contract with their signature.
3. When the payment is recorded via `record_payment`, the settlement contract performs an inter-contract call to the pool contract to `withdraw` the amount from the payer's pool balance.
