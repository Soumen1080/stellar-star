# Stellar Star Production Runbook

## 1. Prerequisites

- Node.js 18+
- npm 9+
- Rust toolchain (for contract work)
- Stellar CLI (for deployment operations)
- Funded Stellar testnet account
- Supabase project with schema from `supabase-setup.sql`

## 2. Environment Setup

Create `.env.local` and set:

- `NEXT_PUBLIC_STELLAR_NETWORK=TESTNET`
- `NEXT_PUBLIC_HORIZON_URL`
- `NEXT_PUBLIC_STELLAR_EXPLORER`
- `NEXT_PUBLIC_SOROBAN_RPC_URL`
- `NEXT_PUBLIC_CONTRACT_ID`
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY`

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
2. Deploy settlement and pool contract instances.
3. Initialize pool and settlement references.
4. Execute one `record_payment` flow that triggers pool withdraw to prove inter-contract behavior.
5. Update `NEXT_PUBLIC_CONTRACT_ID` with settlement contract ID.
6. Save all explorer links in README/docs.

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
