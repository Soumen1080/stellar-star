/**
 * Runs the Playwright suite against a real production-mode build.
 *
 * Invariant this serves (docs/THREAT_MODEL.md §6):
 *   "The E2E suite still runs, including against a production-mode build."
 *
 * A dev server never exercises the production minifier, so a suite that only
 * ever runs against `next dev` says nothing about whether the build-time-gated
 * wallet seam behaves correctly in a real build. This runner sets
 * E2E_PRODUCTION_MODE=1, which makes playwright.config.ts start the server with
 * `next build && next start` instead.
 *
 * The build produced here sets NEXT_PUBLIC_E2E_TEST_MODE=true (via the
 * webServer env in playwright.config.ts) and is therefore a TEST ARTIFACT that
 * must never be deployed. The complementary gate —
 * scripts/verify-no-e2e-bypass.mjs — asserts a flag-LESS build has no seam.
 *
 * A plain env-var prefix (`E2E_PRODUCTION_MODE=1 npx playwright test`) is not
 * portable to Windows shells, and this repo does not take a cross-env
 * dependency, so the variable is set here instead.
 *
 * Usage:  npm run test:e2e:prod [-- --project=chromium]
 */
import { spawnSync } from "node:child_process";

const passthrough = process.argv.slice(2);

const env = {
  ...process.env,
  E2E_PRODUCTION_MODE: "1",
  NEXT_TELEMETRY_DISABLED: "1",
};

const res = spawnSync(
  process.platform === "win32" ? "npx.cmd" : "npx",
  ["playwright", "test", ...passthrough],
  { stdio: "inherit", env },
);

process.exit(res.status ?? 1);
