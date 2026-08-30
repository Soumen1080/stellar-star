# Testnet Reset Recovery

This document describes what happens when Stellar Testnet is reset, how to
recognize it in CI output, and exactly what steps to take to recover.

---

## What is a testnet reset?

Stellar's public testnet is periodically wiped and started fresh (roughly every
3–4 months). When this happens:

- **Every account that existed before the reset is gone.** Their Lumens, sequence
  numbers, and any trustlines disappear.
- **Every deployed smart contract is gone.** Contract IDs that were valid before
  the reset now return 404 from Horizon and Soroban RPC.
- **Friendbot must be used again** to fund new accounts.

---

## How to recognize a testnet reset in CI

### Symptom 1 — `TestnetResetError` in the live-network job

```
[TestnetResetError] Account GABCDE… has sequence 0 or does not exist on testnet.
The testnet was likely reset. Run `npm run e2e:provision` to re-provision fixtures…
```

The live-network workflow emits this as a `::error::` annotation, so it appears
as a red annotation in the GitHub Actions summary. The test is then **skipped**
(not failed) so the live-network job itself stays green while the issue is
clearly surfaced.

### Symptom 2 — Horizon 404 for known account

```
HTTP 404 from https://horizon-testnet.stellar.org/accounts/<publicKey>
```

### Symptom 3 — Soroban RPC returns `contract not found`

```
InvokeHostFunction failed: contract <contractId> not found
```

---

## Recovery procedure

### Step 1 — Re-provision testnet accounts

Run the provisioning script locally or trigger it in CI:

```bash
npm run e2e:provision
```

This will:
1. Generate two fresh Keypairs (payer + recipient)
2. Fund both via Friendbot
3. Write their secrets to `e2e/.testnet-fixtures.json` (gitignored — contains secrets)

Alternatively, in CI:
1. Go to **Actions → Live Stellar Network → Run workflow**
2. Set `re_provision` to `true`
3. Click **Run workflow**

### Step 2 — Update CI secrets

If you use environment variable secrets rather than the fixture file:

1. Go to **Settings → Secrets and variables → Actions**
2. Update `TESTNET_PAYER_SECRET` with the new secret key (output by step 1)
3. Update `TESTNET_RECIPIENT_SECRET` with the new recipient secret

### Step 3 — Re-deploy the Soroban contract (if needed)

If the app uses a Soroban contract (settlement pool), it must be re-deployed:

```bash
# From the contract/ directory:
bash scripts/deploy-contract.sh
```

Then update the contract ID in your environment:

```bash
# In .env.local (local dev) or GitHub Secrets (CI):
NEXT_PUBLIC_CONTRACT_ID=<new-contract-id>
```

### Step 4 — Verify recovery

Re-run the live-network suite:

```bash
npm run test:e2e:live
```

All 5 tests should now pass (or skip gracefully if secrets are not set).

---

## Expected test behaviour during a reset

| Condition | Expected behaviour |
|---|---|
| Accounts gone (reset) | `TestnetResetError` — test **skipped**, CI job **green** |
| Horizon unreachable | `InfrastructureError` — test **skipped**, CI job **green** |
| Friendbot rate-limited | `withRetry` retries 4× with back-off; if still failing, **skipped** |
| Real submission bug | `tx_bad_auth` / `tx_invalid` → test **failed**, CI job **red** |
| Wrong amount / hash | Assertion failure → test **failed**, CI job **red** |

The key invariant: **infrastructure outages produce skips, not failures.
Code regressions produce failures, not skips.**

---

## Prevention

- The nightly live-network workflow runs `provision-testnet.ts` with `--check`
  before each run, so stale accounts are detected immediately.
- Monitor the Stellar blog and Discord `#testnet` channel for reset announcements.
- Stellar typically announces resets at least one week in advance.

---

## Contact

If the recovery procedure above does not resolve the issue, open a GitHub issue
with the label `infra` and include the GitHub Actions run URL.
