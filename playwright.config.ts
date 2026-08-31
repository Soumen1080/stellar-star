import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for Stellar-star end-to-end tests.
 *
 * Projects:
 *
 *   Standard suite (chromium | firefox | webkit)
 *   ─────────────────────────────────────────────
 *   Runs e2e.spec.ts + authenticated-flows.spec.ts on every PR.
 *   Uses the mock wallet seam and an in-memory Supabase fake.
 *   No secrets required.
 *
 *   Live project
 *   ────────────
 *   Runs e2e/live-network.spec.ts against Stellar testnet (Chromium only).
 *   Requires TESTNET_PAYER_SECRET + TESTNET_RECIPIENT_SECRET env vars,
 *   OR a pre-provisioned e2e/.testnet-fixtures.json file (from `npm run e2e:provision`).
 *   Skips gracefully when neither is present — CI does not fail.
 *   Runs on a nightly schedule (see .github/workflows/live-network.yml).
 *
 * Run locally:
 *   npx playwright test                       – standard suite (all 3 desktop browsers)
 *   npx playwright test --project=chromium    – chromium only
 *   npx playwright test --project=live        – live-network suite (needs provisioned accounts)
 *   npx playwright test --ui                  – interactive UI mode
 *
 * The base URL points to the local Next.js dev server.
 * In CI the server is started via `webServer` below.
 *
 * Dev server vs production-mode build
 * ───────────────────────────────────
 * By default the suite drives `next dev`, which is fast to iterate against.
 * Set `E2E_PRODUCTION_MODE=1` to instead build and serve a real production
 * bundle (`next build && next start`).
 *
 * This matters for the security invariant in docs/THREAT_MODEL.md §6: the E2E
 * wallet seam is gated on the build-time flag `NEXT_PUBLIC_E2E_TEST_MODE`, and
 * a dev server does not exercise the production minifier's dead-code
 * elimination at all. Running the suite in production mode proves the seam
 * still works when the flag IS set through a real build — which is what makes
 * the complementary assertion (that a flag-LESS build has no seam, see
 * scripts/verify-no-e2e-bypass.mjs) a meaningful gate rather than a claim about
 * an untested configuration.
 *
 * A production-mode run here is still a TEST ARTIFACT: it is built with
 * NEXT_PUBLIC_E2E_TEST_MODE=true and must never be deployed.
 *
 *   E2E_PRODUCTION_MODE=1 npx playwright test --project=chromium
 */
const PRODUCTION_MODE = process.env.E2E_PRODUCTION_MODE === "1";
export default defineConfig({
  testDir: "./e2e",

  /* Run standard suite files in parallel; live tests run sequentially */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI for the standard suite */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter */
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : [["html"]],

  use: {
    /* Base URL for all page.goto("/") calls */
    baseURL: "http://localhost:3000",
    /* Collect trace on first retry */
    trace: "on-first-retry",
    /* Screenshot only on failure */
    screenshot: "only-on-failure",
    /* Video only on first retry in CI */
    video: process.env.CI ? "on-first-retry" : "off",
  },

  projects: [
    /* ── Standard suite: Desktop browsers ───────────────────────────────── */
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
      testMatch: ["**/e2e.spec.ts", "**/authenticated-flows.spec.ts"],
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
      testMatch: ["**/e2e.spec.ts", "**/authenticated-flows.spec.ts"],
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
      testMatch: ["**/e2e.spec.ts", "**/authenticated-flows.spec.ts"],
    },

    /* ── Standard suite: Mobile viewports ───────────────────────────────── */
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
      testMatch: ["**/e2e.spec.ts"],
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
      testMatch: ["**/e2e.spec.ts"],
    },

    /* ── Live-network project ────────────────────────────────────────────── */
    {
      name: "live",
      use: {
        ...devices["Desktop Chrome"],
        // Longer navigation timeout for real network operations
        navigationTimeout: 30_000,
        actionTimeout: 30_000,
      },
      // Only runs live-network.spec.ts — excluded from standard suite runs
      testMatch: ["**/live-network.spec.ts"],
      // 3 retries for live tests: absorbs transient testnet blips
      retries: 3,
      // Run live tests sequentially to avoid nonce conflicts on shared accounts
      fullyParallel: false,
      workers: 1,
    },
  ],

  /* Start the Next.js server before running tests in CI.
   * Dev server by default; a real production build when E2E_PRODUCTION_MODE=1.
   * The build must happen inside this command so it inherits the env below —
   * NEXT_PUBLIC_E2E_TEST_MODE is inlined at BUILD time, not at serve time. */
  webServer: {
    command: PRODUCTION_MODE
      ? "npm run build && npm run start"
      : "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    // A production build needs materially longer than starting a dev server.
    timeout: PRODUCTION_MODE ? 300_000 : 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "ci-placeholder-key",
      SUPABASE_JWT_SECRET: process.env.SUPABASE_JWT_SECRET ?? "e2e-test-only-jwt-secret-not-used-in-production",
      // Build-time flag that activates the E2E wallet seam in
      // lib/stellar/e2eWallet.ts. The server started here (by Playwright) is
      // built/served with this flag, so authenticated-flow tests can drive the
      // UI without a real wallet extension. A NORMAL production build omits
      // this flag, which removes the seam from the bundle entirely.
      NEXT_PUBLIC_E2E_TEST_MODE: "true",
    },
  },
});
