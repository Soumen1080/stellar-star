import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright configuration for SettleX end-to-end tests.
 *
 * Run locally:
 *   npx playwright test          – headless (all browsers)
 *   npx playwright test --ui     – interactive UI mode
 *   npx playwright test --headed – headed Chromium
 *
 * The base URL points to the local Next.js dev server.
 * In CI the server is started via `webServer` below.
 */
export default defineConfig({
  testDir: "./e2e",
  /* Run files in parallel */
  fullyParallel: true,
  /* Fail the build on CI if you accidentally left test.only in the source */
  forbidOnly: !!process.env.CI,
  /* Retry on CI only */
  retries: process.env.CI ? 2 : 0,
  /* Opt out of parallel tests on CI */
  workers: process.env.CI ? 1 : undefined,
  /* Reporter to use – HTML report by default, line reporter in CI */
  reporter: process.env.CI ? "github" : "html",

  use: {
    /* Base URL for all page.goto("/") calls */
    baseURL: "http://localhost:3000",
    /* Collect trace on first retry */
    trace: "on-first-retry",
    /* Screenshot only on failure */
    screenshot: "only-on-failure",
  },

  projects: [
    /* ── Desktop browsers ───────────────────────────────────────── */
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },

    /* ── Mobile viewports ───────────────────────────────────────── */
    {
      name: "Mobile Chrome",
      use: { ...devices["Pixel 5"] },
    },
    {
      name: "Mobile Safari",
      use: { ...devices["iPhone 12"] },
    },
  ],

  /* Start the Next.js dev server before running tests in CI */
  webServer: {
    command: "npm.cmd run dev",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://example.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "ci-placeholder-key",
    },
  },
});
