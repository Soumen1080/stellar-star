# Stellar Star — codebase repair report

Audit date: 27 November 2026. This report is based on the repository source, the supplied `npm install` / `npm run dev` output, ESLint, TypeScript, and the Jest suite. Items marked **critical** or **high** should be resolved before deployment.

## 1. **Critical** — the development server cannot compile middleware

- Evidence: `npm run dev` fails with `UnhandledSchemeError: Reading from "node:crypto" is not handled`, traced to `lib/security/csp.ts`, imported by `middleware.ts`.
- Problem: `middleware.ts` runs in Next.js's Edge runtime. `lib/security/csp.ts` imports Node's `crypto` module (`node:crypto`), which is not available there.
- Why this matters:
  - The home page returns 404/does not start normally because middleware compilation fails.
  - Every page request passes through this middleware, so this is an application-wide availability failure.
- Fix:
  - Split the CSP helpers into Edge-safe and Node-only modules.
  - Generate the nonce in middleware with the Web Crypto API (`crypto.getRandomValues`) and browser/Edge-safe base64 encoding.
  - Keep Node-only hashing, UUID and report-sanitising logic in a server-only module used only by route handlers.
  - Add an integration test that requests `/` with middleware enabled.

## 2. **Critical** — three v1 webhook route files have invalid TypeScript syntax

- Evidence: `npx tsc --noEmit` and `npm run lint` both fail in:
  - `app/api/v1/webhooks/route.ts:90`
  - `app/api/v1/webhooks/[id]/route.ts:68`
  - `app/api/v1/webhooks/test/route.ts:68`
- Problem: the handlers contain stray closing `}, }); }` blocks left from an incomplete idempotency refactor. The delete handler also has duplicate audit logging.
- Why this matters:
  - TypeScript cannot type-check the project.
  - ESLint cannot lint the project.
  - Next cannot compile these API routes, so webhook creation, deletion and test delivery are unavailable.
- Fix:
  - Rebuild each handler's control flow with correctly balanced `try/catch` blocks.
  - Either wrap each write in `runIdempotentMutation`, or remove the incomplete wrapper code consistently.
  - Remove the duplicate `recordAuditLog` in `[id]/route.ts` and retain the call containing the actual idempotency key.
  - Import every helper actually used (`parseJsonBody`, `toPublicErrorResponse`, etc.).
  - Run `npx tsc --noEmit`, `npm run lint`, and the webhook API tests before merging.

## 3. **Critical** — API idempotency authentication calls a function that is not defined

- Evidence: `lib/api/middleware.ts:221` calls `requireIdempotencyKey(...)`, but the module neither imports nor defines it. Jest reports `ReferenceError: requireIdempotencyKey is not defined` for `POST /api/v1/trips`.
- Problem: all callers of `authenticateApiRequest(..., { requireIdempotencyKey: true })` can throw a server error instead of validating the header.
- Why this matters:
  - Clients receive HTTP 500 instead of a clear HTTP 400 for missing/invalid idempotency keys.
  - Retry-safe financial writes can fail before their business logic is reached.
- Fix:
  - Import the canonical key validator from the idempotency module, or restore its local implementation.
  - Test valid, absent, malformed and too-short keys at the middleware boundary.
  - Do not use a type cast such as `as string` until validation has succeeded.

## 4. **Critical** — idempotency is inconsistently implemented for mutating API routes

- Evidence from `__tests__/security/requiredIdempotencyKeys.test.ts`:
  - `/api/account/delete` and `/api/v1/expenses` do not call `runIdempotentMutation`.
  - `/api/v1/tokens` and `/api/v1/tokens/[id]` lack the expected key-check path.
  - All three v1 webhook write routes lack the durable idempotency wrapper.
  - Nine additional POST routes are unclassified in the idempotency policy.
- Problem: a network retry can repeat a financial or security-sensitive action, or routes may not have an explicit decision explaining why idempotency is unnecessary.
- Why this matters:
  - Duplicate expenses, duplicate token/webhook changes, and ambiguous account-deletion outcomes are possible.
  - The security control is difficult to audit because route coverage is incomplete.
- Fix:
  - Inventory every POST, PUT, PATCH and DELETE handler.
  - For each handler, explicitly choose one of: durable idempotency with `runIdempotentMutation`, an idempotent domain operation, or a documented exemption in the policy registry.
  - Supply `replayFields` to every durable mutation; the trips endpoint currently omits them.
  - Set `persist: false` for payloads containing one-time secrets; the webhook route currently fails this expectation.
  - Add a retry test for every money-moving or state-changing endpoint.

## 5. **High** — retrying an invitation claim turns an expected client error into HTTP 500

- Evidence: `__tests__/security/requiredIdempotencyKeys.test.ts` expects the first failed claim to return 400 but receives 500.
- Problem: an expected domain failure is being passed through the generic internal-error path.
- Why this matters:
  - A user cannot distinguish invalid/expired invite input from a server outage.
  - Client retry and recovery logic makes the wrong decision on a 500 response.
- Fix:
  - Map known invitation/claim validation errors to a stable public 4xx response in `app/api/invitations/claim/route.ts`.
  - Ensure a failed operation releases or records the idempotency claim correctly so retrying the same key works.

## 6. **Critical** — `supabase-setup.sql` contains a live merge-conflict separator

- Evidence: line 9503 contains a bare `=======` between migration content.
- Problem: `=======` is not valid SQL. It is a Git conflict marker fragment that was committed into the setup script.
- Why this matters:
  - A fresh Supabase setup using this advertised one-shot script will stop with a SQL syntax error.
  - The database can be left only partially initialized, producing difficult-to-diagnose runtime failures and missing security controls.
- Fix:
  - Resolve the underlying merge deliberately; do not merely delete the marker without reviewing the surrounding migrations.
  - Rebuild or regenerate the consolidated setup SQL from the canonical migrations.
  - Execute it against an empty disposable database in CI.

## 7. **High** — the one-shot Supabase script is missing migrations that the application requires

- Evidence:
  - `__tests__/security/idempotencyRetention.test.ts` reports that migration `0024_idempotency_retention` is not mirrored into `supabase-setup.sql`.
  - `__tests__/settlement/reconciliationLeasedQueue.test.ts` reports the missing `public.claim_reconciliation_jobs` function from migration `0026_reconciliation_leased_queue`.
- Problem: the canonical migration files and the alternative one-shot setup route have diverged.
- Why this matters:
  - Fresh installs do not get idempotency retention/cleanup or the reconciliation queue function.
  - Production behavior differs depending on how the database was provisioned.
- Fix:
  - Make the migration directory the single source of truth.
  - Generate `supabase-setup.sql` from the ordered manifest, rather than manually copying blocks.
  - Add every missing migration through `0032`, then verify both a fresh setup and incremental migration path in CI.

## 8. **High** — the migration manifest declares the wrong total and reuses version numbers

- Evidence: `migrations/manifest.json` states `totalMigrations: 50`, but contains 53 entries and the directory contains 53 SQL files. Several human-readable `version` values are duplicated (for example `0019`, `0020`, `0021`, and `0026`).
- Problem: the manifest's metadata is internally inconsistent. Duplicate display versions are only safe if every migration tool uses the immutable `id` plus ordered `sequence`; any version-based tooling can skip or overwrite entries.
- Why this matters:
  - Validation, release checks, and operator confidence become unreliable.
  - A migration runner that keys by `version` could fail to apply schema/security changes.
- Fix:
  - Correct `totalMigrations` to 53.
  - Confirm the migration runner and database ledger use immutable `id`/`sequence`, never `version` alone.
  - Prefer unique, monotonically increasing migration version prefixes for future files, or document and enforce the alternative identity model.
  - Add a manifest test that checks count, file set, ids, sequences, checksums and version policy.

## 9. **High** — required background jobs are not scheduled on Vercel

- Evidence: `vercel.json` schedules recurring expenses, receipt retention, reminders and webhook dispatch, but not:
  - `/api/idempotency/cleanup`
  - `/api/settlement/reconciliation-worker/cron`
- Problem: both routes exist but are never invoked by the deployed scheduler.
- Why this matters:
  - Old idempotency records accumulate, increasing storage and potentially retaining replay/audit data longer than intended.
  - On-chain settlement reconciliation does not run automatically, so paid shares can remain pending.
- Fix:
  - Add cron entries with appropriate daily/frequent schedules and document the chosen cadence.
  - Configure `CRON_SECRET` in the deployment environment.
  - Add a deployment/configuration test that compares every required worker route against `vercel.json`.

## 10. **Medium** — reconciliation worker test and implementation contract have drifted

- Evidence: `__tests__/security/reconciliationWorkerAuth.test.ts` expects `executeReconciliationRun` to receive `{ batchSize, walletAddress }`; the implementation now also passes `workerId`, `deadline`, and `clock`.
- Problem: the test asserts an exact argument object, so a valid implementation enhancement breaks the suite.
- Why this matters:
  - CI is red even though the added safeguards may be intentional.
  - It obscures genuine reconciliation failures.
- Fix:
  - Decide whether the new arguments are part of the public worker contract.
  - If intentional, update the test to use `expect.objectContaining` and assert the new fields separately.
  - If unintended, remove them and keep the contract minimal.

## 11. **Medium** — Stellar asset environment overrides do not work in the tested runtime

- Evidence: `__tests__/stellar/assets.test.ts` fails for `NEXT_PUBLIC_USDC_ISSUER` and both JSON and comma-separated `NEXT_PUBLIC_STELLAR_ASSETS` formats.
- Problem: `lib/config/publicEnv.ts` snapshots environment values at module import time. Later values are ignored by `getAssetRegistry`, including in tests and potentially in server processes where configuration is changed/reloaded.
- Why this matters:
  - A configured USDC issuer can silently fall back to the default issuer.
  - Custom assets are absent, blocking trustline/payment flows or targeting the wrong asset.
- Fix:
  - Make asset registry configuration an explicit input, or read the allowed environment value when building the registry.
  - For browser code, keep build-time public configuration explicit and immutable; for server code, validate values during startup.
  - Add tests for default, override, JSON list, CSV list, malformed input and network/issuer mismatch.

## 12. **High** — unsupported Node.js and npm versions are being used

- Evidence from the supplied install log: project requirement is Node `>=20.9.0 <23` and npm `10.8.2`; current environment is Node `24.18.0` and npm `12.0.2`.
- Problem: the current runtime is outside the tested/supported range.
- Why this matters:
  - Dependency installation can resolve differently and native/postinstall packages may behave differently.
  - Failures cannot confidently be attributed to the application versus the unsupported runtime.
- Fix:
  - Install and select Node 20 LTS or Node 22 LTS using a version manager.
  - Use Corepack to activate `npm@10.8.2` as declared in `package.json`.
  - Add `.nvmrc` or a Volta configuration and enforce engines in CI.

## 13. **High** — ESLint dependency versions are incompatible

- Evidence from the supplied install log and `npm ls`:
  - Root uses `eslint@9.39.4`.
  - `eslint-config-next@15.5.26` installs `@typescript-eslint/*@6.15.0`, whose peer range is ESLint 7 or 8.
  - ESLint reports missing rule `@typescript-eslint/no-require-imports` in two test files.
- Problem: lint tooling has an invalid peer-dependency tree, so configured rules are not reliably available.
- Why this matters:
  - `npm run lint` fails and cannot be trusted as a quality gate.
  - Developers can miss real static-analysis errors.
- Fix:
  - Use a mutually compatible stack: either pin ESLint 8 with the installed Next configuration, or upgrade Next/its lint dependencies to a release that fully supports ESLint 9.
  - Delete `node_modules` and run `npm ci` only after changing the lockfile deliberately.
  - Keep the compatibility decision in CI with `npm ls eslint @typescript-eslint/parser`.

## 14. **Medium** — package post-install scripts were blocked

- Evidence from the supplied `npm install` log: install scripts were blocked for `esbuild`, `tesseract.js`, and `unrs-resolver`.
- Problem: these packages may lack downloaded binaries or completed setup.
- Why this matters:
  - Builds and OCR can fail later with confusing missing-binary/module errors.
  - The application may work on one machine and fail on another depending on script-approval state.
- Fix:
  - Review the exact scripts with `npm install-scripts ls`.
  - Approve only packages reviewed and required by the project, then reinstall on the supported Node/npm version.
  - Document this prerequisite or use a package-manager policy that is reproducible in CI.

## 15. **Low** — deprecated transitive packages need an upgrade plan

- Evidence from the install log: `inflight@1.0.6`, `glob@7.2.3`, and `whatwg-encoding@3.1.1` are deprecated; `glob@7` is called out as having known security vulnerabilities by its maintainer.
- Problem: old indirect dependencies stay in the dependency graph.
- Why this matters:
  - Maintenance and future Node compatibility become harder.
  - `npm audit` could not be completed here because the audit endpoint was unreachable, so the current vulnerability status needs a successful online check in CI.
- Fix:
  - Run `npm explain inflight glob whatwg-encoding` to identify the parent packages.
  - Upgrade or replace the parent dependencies; do not force an incompatible `glob` override blindly.
  - Run `npm audit --omit=dev` in CI with network access and address confirmed findings.

## 16. **Low** — React hook dependency warnings can cause stale UI state

- Evidence: ESLint reports missing dependencies in:
  - `components/developer/ProviderHealthDashboard.tsx` (`fetchProviders`)
  - `context/ExpenseContext.tsx` (`createCorrection`, `voidExpense`)
  - `hooks/useExpenseForm.ts` (`locale`)
  - `hooks/usePayment.ts` (`pendingOnChain`, `pendingOnChain?.txHash`)
- Problem: effects and callbacks close over outdated values when their missing dependencies change.
- Why this matters:
  - Users can see stale provider health, locale formatting, expense behavior, or payment status.
  - The issue can be intermittent and difficult to reproduce.
- Fix:
  - Include the missing dependencies, then use `useCallback`/`useMemo` to stabilize functions where necessary.
  - Do not suppress the rule unless the behavior is intentionally one-time and documented.
  - Add interaction tests for payment status and locale changes.

## 17. **Low** — broad `any` usage weakens TypeScript safety in financial and API code

- Evidence: examples include request bodies in `app/api/v1/expenses/route.ts`, member mapping in `app/api/v1/trips/route.ts`, Supabase data access in `lib/api/data.ts`, and several UI error handlers.
- Problem: values are accepted without a compile-time contract and errors move to runtime.
- Why this matters:
  - Malformed request data can reach calculations, persistence, or rendering paths.
  - Refactors can silently break API/data shape compatibility.
- Fix:
  - Define request/response schemas and infer TypeScript types from them.
  - Replace `any` in external data boundaries with `unknown`, validate it, then narrow it.
  - Generate and use Supabase database types instead of casting clients and rows to `any`.

## Verification status

- `npm run dev`: **failed** — Edge/`node:crypto` middleware compile error.
- `npx tsc --noEmit`: **failed** — syntax errors in the three v1 webhook routes.
- `npm run lint`: **failed** — the same syntax errors, invalid ESLint dependency/rule resolution, and seven warnings.
- `npm test -- --runInBand`: **failed** — confirmed failures cover idempotency, migration parity, background-job scheduling, reconciliation worker contract, and Stellar asset overrides.
- `npm audit --omit=dev`: **not completed** — npm's audit endpoint was unavailable in this environment. The install itself reported zero vulnerabilities, but that is not a replacement for a successful audit.

## Recommended repair order

1. Switch to the supported Node/npm versions.
2. Fix the Edge middleware import and the webhook-route syntax/import errors so the app can build.
3. Restore one consistent idempotency path across every mutation and make all idempotency tests pass.
4. Resolve the SQL conflict marker, synchronize migrations/setup SQL/manifest, and test a blank database.
5. Add the missing cron schedules.
6. Repair the asset configuration contract, then resolve lint warnings and type-safety debt.