# Release Readiness Scorecard (#447)

The release readiness scorecard combines the repository's separate safety controls into one
verifiable promotion decision. It evaluates a committed, machine-readable policy
([`release/readiness-policy.json`](../release/readiness-policy.json)) against the repository,
collected evidence, and accountable exceptions
([`release/exceptions.json`](../release/exceptions.json)). The result is **PROMOTE** or **BLOCK**,
and each evaluation is written to a hash-chained audit record.

```bash
npm run release:scorecard                    # enforce: exit 1 on BLOCK
npm run release:scorecard -- --report-only   # advisory: print the scorecard, always exit 0
npm run release:evidence -- --name slos --source "status exporter" --from slo-window.json
npm run release:audit:verify                 # verify the audit log hash chain
```

Implementation: [`lib/release/scorecard.ts`](../lib/release/scorecard.ts) (pure evaluator) and
[`scripts/release-scorecard.ts`](../scripts/release-scorecard.ts) (CLI). Tests:
[`__tests__/release/scorecard.test.ts`](../__tests__/release/scorecard.test.ts).

## 1. Decision rules

1. Each requirement runs one machine check. If the check finds anything, the requirement **fails**.
2. A failed **blocking** requirement blocks promotion unless a valid exception covers it. A covered
   requirement shows as **overridden**, and its findings stay visible.
3. If the policy is invalid, the decision is BLOCK. A policy is invalid if a domain has no requirements,
   a requirement has no owner, or two requirements share an ID.
4. A check that crashes counts as a failed check, so the gate fails closed.
5. Non-blocking failures and rejected exceptions show up as warnings in the scorecard and in the
   audit record.

## 2. Requirements

| ID | Domain | Check | Overridable |
| :--- | :--- | :--- | :--- |
| MIG-01 | migrations | Manifest tracks every migration file with a matching SHA-256 and a contiguous sequence | No |
| MIG-02 | migrations | Every migration with sequence 42 or higher has `-- Rollback:` notes | Yes |
| RLS-01 | rls | Every table in `supabase-setup.sql` enables RLS. Partitions are exempt because they inherit through the parent; `schema_migrations` is exempt because it is runner-only | No |
| PERF-01 | performance | Committed query-plan fixtures show no sequential scans | Yes |
| PERF-02 | performance | Evidence `performance`: p95 ≤ 800 ms, error rate ≤ 1 %, max age 14 days | Yes |
| SEC-01 | security | Every finding row in `SECURITY_AUDIT_REPORT.md` is **FIXED** | No |
| SEC-02 | security | Evidence `security-build`: the wallet-bypass build gate passed, max age 1 day | No |
| BAK-01 | backups | Evidence `restore-drill`: drill passed, tampering detected, RTO ≤ 30 min, max age 7 days | Yes |
| BAK-02 | backups | Evidence `backup-snapshot`: a verified backup no older than 26 hours | Yes |
| DEP-01 | dependencies | Every declared dependency is locked with an integrity hash; no `*`, `latest` or `>=` ranges | No |
| DEP-02 | dependencies | Evidence `npm-audit`: zero critical or high advisories in production dependencies, max age 1 day | Yes |
| SLO-01 | slos | Evidence `slos`: window ≥ 28 days, availability ≥ 99.9 %, error budget ≥ 0 | Yes |
| CON-01 | contracts | Deployed WASM SHA-256 recorded in the security audit report | No |
| CON-02 | contracts | Evidence `contracts`: `cargo test` passed on the release commit, max age 1 day | No |
| RB-01 | rollback | Runbook has a rollback section | No |
| RB-02 | rollback | Forward-compatible database rollback procedure is documented | No |
| RB-03 | rollback | Evidence `rollback-plan`: names the previous release commit and a verifier, rehearsed within 30 days | Yes |

## 3. Evidence

Evidence files live in `release/evidence/<name>.json` and share one envelope:

```json
{
  "name": "slos",
  "collectedAt": "2026-11-22T06:00:00.000Z",
  "source": "status exporter",
  "commit": "<sha the evidence describes>",
  "data": { "windowDays": 28, "availability": 0.9994, "errorBudgetRemaining": 0.4 }
}
```

The `release:evidence` command creates this envelope around any raw JSON. Evidence is rejected if
it is missing, unparsable, mislabelled, dated in the future, or older than the requirement's
`maxAgeDays`.

| Evidence | Produced by | Where |
| :--- | :--- | :--- |
| `security-build` | `npm run test:security-build` | CI (`p0-release-gate`) |
| `contracts` | `cargo test` | CI (`contract-evidence`) |
| `npm-audit` | `npm audit --omit=dev --json` | CI (`release-scorecard`) |
| `restore-drill` | `node scripts/recovery-drill.mjs --evidence-out …` | CI (`release-scorecard`) |
| `performance` | Release-candidate load test (`data.p95Ms`, `data.errorRate`, `data.commit`) | Committed by @sre-lead |
| `slos` | Production SLO window export | Committed by @sre-lead |
| `backup-snapshot` | Production backup job (`data.verified`, `data.lastSuccessfulBackupAt`) | Committed by @sre-lead |
| `rollback-plan` | Release commander (`data.previousReleaseCommit`, `data.verifiedBy`, `data.rehearsedAt`) | Committed by @release-mgmt |

CI cannot fabricate the four production-sourced files. Until their owners commit them, an enforced
promotion is blocked, which is the intended behaviour.

## 4. Accountable exceptions

An exception in `release/exceptions.json` waives one failed requirement temporarily:

```json
{
  "id": "EXC-2026-11-001",
  "requirement": "SLO-01",
  "reason": "Status provider outage hid three days of probes",
  "compensatingControl": "Manual synthetic checks every 15 minutes until the window refills",
  "ticket": "OPS-123",
  "requestedBy": "@release-mgmt",
  "approvedBy": "@sre-lead",
  "createdAt": "2026-11-21T00:00:00Z",
  "expiresAt": "2026-11-28T00:00:00Z"
}
```

An exception is applied only if **all** of the following hold. Otherwise it is rejected and
recorded:

- Every field above is present and non-empty.
- The targeted requirement exists and is `overridable`.
- `approvedBy` is listed for that requirement's domain in `approvers`, and differs from `requestedBy`.
- The exception has not expired, its `createdAt` is not in the future, and its lifetime is at most
  `maxExceptionDays` (14).

Exceptions are committed through a reviewed pull request, so the change history is also in git.

## 5. Audit trail

Each evaluation appends one JSON line to `release/out/promotion-audit.jsonl` and writes the full
scorecard to `release/out/scorecard.json`. The record contains:

- The decision, whether it was enforced, the target, the commit, the actor, and the CI run ID.
- SHA-256 digests of the policy, the exceptions file, and the full scorecard.
- For each requirement: its status, the exception applied (if any), and the SHA-256 of every file
  its check read.
- The applied overrides (requester, approver, ticket, expiry) and the rejected exceptions with
  their reasons.
- `prevHash` and `hash`. The hash is SHA-256 over the canonical JSON of the record.

`verify-audit` recomputes every hash and link. Editing a record breaks its own hash. Deleting a
record breaks the next record's link. The CLI refuses to append to a log that fails verification.
CI uploads the scorecard, audit record, evidence and exceptions as the
`release-scorecard-<run>-<attempt>` artifact with 90-day retention.

## 6. CI behaviour

In `.github/workflows/production-check.yml`, the `release-scorecard` job runs after
`p0-release-gate`, `production-readiness` and `contract-evidence`. `production-deploy-gate` depends
on it.

- **`workflow_dispatch` with `target_network = PUBLIC`** is a promotion. The scorecard is enforced,
  and a BLOCK fails the deploy gate.
- **Pushes and pull requests** are not promotions. The scorecard runs with `--report-only` and is
  published to the job summary without failing the build.

## 7. Adding a requirement

Add an entry to `requirements` with a unique ID, one of the nine domains, an accountable `owner`,
`blocking` and `overridable` flags, and a `check`. Check types are `migration-manifest`,
`migration-rollback-notes`, `rls-enabled`, `query-plan-fixtures`, `file-contains`, `line-rules`,
`lockfile-integrity` and `evidence`. Evidence assertions support `==`, `!=`, `<`, `<=`, `>`, `>=`,
`exists` and `maxAgeHours`.
