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
 */
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

  /* Start the Next.js dev server before running tests in CI */
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
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
