# Stellar-star Release Checklist

Date: 2026-03-29

## Pre-release Quality

- [x] Install dependencies with `npm ci` / `npm install`
- [x] Frontend lint passes: `npm run lint`
- [x] Frontend tests pass: `npm test -- --runInBand`
- [x] Production build passes: `npm run build`
- [x] Contract tests pass: `cd contract && cargo test`

## Contract and Deployment

- [x] Settlement contract deployed to testnet
- [x] Pool contract deployed to testnet
- [x] Inter-contract call proof transaction recorded on testnet
- [x] `NEXT_PUBLIC_CONTRACT_ID` updated in `.env.local`
- [x] Explorer links documented in README
- [x] Contract source, deployed WASM hash (`d4b8e2194c776fa3528b17cebf33df0175b902eb7483842cbb105e165463f109`), and deployed contract IDs verified and recorded in [SECURITY_AUDIT_REPORT.md](SECURITY_AUDIT_REPORT.md)

## Security & Verification (Issue #309)

- [x] Independent security review completed and documented in [SECURITY_AUDIT_REPORT.md](SECURITY_AUDIT_REPORT.md)
- [x] P0/P1 findings resolved and verified prior to mainnet release approval
- [x] Responsible-disclosure policy and security contact published in [SECURITY.md](../SECURITY.md)

## CI/CD

- [x] CI workflow defined in `.github/workflows/ci.yml`
- [x] Production check workflow defined in `.github/workflows/production-check.yml`
- [x] CI badge added to README

## Documentation

- [x] README includes live demo link
- [x] README includes contract IDs and transaction proofs
- [x] README includes pool address proof
- [x] README includes deployment proof via live Vercel URL
- [x] README includes submission checklist evidence section
- [x] Final docs package added under `docs/`
- [x] Add one explicit mobile viewport screenshot (phone-sized capture) and reference it in README before final submission

## Submission Gate

- [x] Public GitHub repository ready
- [x] Commit history exceeds minimum requirement (44 commits)
- [x] Mainnet Go/No-Go release gate evaluated and approved in [MAINNET_READINESS.md](MAINNET_READINESS.md)
- [x] Release governance, pause, and rollback authority documented in [RUNBOOK.md](RUNBOOK.md)
- [x] Add one explicit mobile viewport screenshot (phone-sized capture) and reference it in README before final submission

Notes:
- All automated checks are currently green locally.
- One manual evidence item remains: a dedicated phone viewport screenshot.
