# Stellar Star Release Checklist

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

## CI/CD

- [x] CI workflow defined in `.github/workflows/ci.yml`
- [x] Production check workflow defined in `.github/workflows/production-check.yml`
- [x] CI badge added to README

## Documentation

- [x] README includes live demo link
- [x] README includes contract IDs and transaction proofs
- [x] README includes pool address proof
- [x] README includes deployment screenshot (`public/deployment.png`)
- [x] README includes submission checklist evidence section
- [x] Final docs package added under `docs/`

## Submission Gate

- [x] Public GitHub repository ready
- [x] Commit history exceeds minimum requirement (44 commits)
- [ ] Add one explicit mobile viewport screenshot (phone-sized capture) and reference it in README before final submission

Notes:
- All automated checks are currently green locally.
- One manual evidence item remains: a dedicated phone viewport screenshot.
