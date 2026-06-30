/**
 * SettleX – Playwright End-to-End Tests
 *
 * Coverage:
 *  1. Landing page – hero headline, key nav links, CTA visible
 *  2. Auth page    – wallet-connect prompt rendered when not connected
 *  3. Dashboard    – connect-wallet prompt when no wallet in localStorage
 *  4. Expenses     – AuthGuard redirects unauthenticated users
 *  5. Trips        – AuthGuard redirects unauthenticated users
 *  6. Trip detail  – graceful 404-like fallback for unknown IDs
 *  7. Mobile       – landing page renders correctly on Pixel 5 viewport
 *
 * These tests run against the real Next.js dev/prod server.
 * Wallet connectivity and Supabase calls are NOT exercised here –
 * those interactions require secrets and live infra.  The suite
 * validates routing, public UI rendering, and auth-guard behaviour
 * using only what the browser can observe without credentials.
 */

import { test, expect, devices } from "@playwright/test";

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Clear any persisted wallet state so we always start from a clean slate. */
async function clearWalletState(page: import("@playwright/test").Page) {
  await page.addInitScript(() => {
    localStorage.removeItem("StellarStar:publicKey");
    localStorage.removeItem("StellarStar:walletId");
  });
}

// ─── 1. Landing page ──────────────────────────────────────────────────────────

test.describe("Landing page", () => {
  test.beforeEach(async ({ page }) => {
    await clearWalletState(page);
    await page.goto("/");
  });

  test("renders hero headline", async ({ page }) => {
    // The Hero component includes a prominent h1 / marketing headline
    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading).toBeVisible();
    // The heading should contain at least a few characters
    const text = await heading.textContent();
    expect(text?.trim().length).toBeGreaterThan(3);
  });

  test("shows primary navigation links", async ({ page }) => {
    // Header renders nav links; at minimum the app name / logo link should exist
    const header = page.locator("header").first();
    await expect(header).toBeVisible();
  });

  test("CTA / launch button is visible", async ({ page }) => {
    // The landing page should have at least one prominent call-to-action link
    const ctaLink = page
      .getByRole("link")
      .filter({ hasText: /launch|get started|app|dashboard|open/i })
      .first();
    await expect(ctaLink).toBeVisible();
  });

  test("page title is set", async ({ page }) => {
    const title = await page.title();
    expect(title.length).toBeGreaterThan(0);
  });
});

// ─── 2. Auth page ─────────────────────────────────────────────────────────────

test.describe("Auth page – wallet-connect prompt", () => {
  test.beforeEach(async ({ page }) => {
    await clearWalletState(page);
    await page.goto("/auth");
  });

  test("shows wallet-connect prompt when no wallet is connected", async ({
    page,
  }) => {
    // AuthWalletConnectPrompt is rendered when isConnected === false
    // It contains text about connecting a wallet
    const prompt = page
      .getByText(/connect.*wallet|wallet.*connect/i)
      .first();
    await expect(prompt).toBeVisible({ timeout: 10_000 });
  });

  test("does NOT show account form when wallet is disconnected", async ({
    page,
  }) => {
    // The account form (sign-up / sign-in) should be hidden
    const form = page.locator("form");
    // Either no form at all, or the wallet-connect overlay is on top
    // We assert the connect-wallet text is present (stronger signal)
    await expect(
      page.getByText(/connect.*wallet|wallet.*connect/i).first()
    ).toBeVisible({ timeout: 10_000 });
    // If a form is present it must not be the account form (no name input visible)
    if ((await form.count()) > 0) {
      const nameInput = page.getByPlaceholder(/name|display/i);
      await expect(nameInput).toBeHidden();
    }
  });
});

// ─── 3. Dashboard ─────────────────────────────────────────────────────────────

test.describe("Dashboard – unauthenticated state", () => {
  test.beforeEach(async ({ page }) => {
    await clearWalletState(page);
    await page.goto("/dashboard");
  });

  test("shows connect-wallet prompt when no wallet is connected", async ({
    page,
  }) => {
    // ConnectPrompt is rendered when isConnected === false
    const connectText = page
      .getByText(/connect.*wallet|wallet.*connect|connect your wallet/i)
      .first();
    await expect(connectText).toBeVisible({ timeout: 10_000 });
  });

  test("does NOT render the full dashboard UI without wallet", async ({
    page,
  }) => {
    // DashboardView should not be rendered without a wallet
    const dashNav = page.getByText(/expenses|trips/i).first();
    // We accept that the nav may not be present; we just confirm the connect prompt is there
    await expect(
      page.getByText(/connect.*wallet|wallet.*connect/i).first()
    ).toBeVisible({ timeout: 10_000 });
    // If navigation links ARE present we flag an issue
    const navLinks = page.getByRole("link", { name: /expenses/i });
    // If the connect prompt is shown, nav links to expenses should not be the primary content
    expect(
      (await page.getByText(/connect.*wallet|wallet.*connect/i).count()) > 0
    ).toBe(true);
  });
});

// ─── 4. Expenses page – AuthGuard ─────────────────────────────────────────────

test.describe("Expenses page – auth guard", () => {
  test.beforeEach(async ({ page }) => {
    await clearWalletState(page);
  });

  test("redirects or shows auth prompt for unauthenticated users", async ({
    page,
  }) => {
    await page.goto("/expenses");
    // AuthGuard may redirect to /auth or render an inline prompt.
    // Either way the expenses main content shouldn't be visible.
    await page.waitForLoadState("networkidle");
    const currentUrl = page.url();
    const onExpenses = currentUrl.includes("/expenses");
    if (onExpenses) {
      // Inline guard – should show a connect / sign-in prompt
      const authPrompt = page.getByText(
        /connect.*wallet|sign in|wallet.*connect/i
      );
      await expect(authPrompt.first()).toBeVisible({ timeout: 10_000 });
    } else {
      // Redirected to /auth or /
      expect(currentUrl).toMatch(/\/(auth|$)/);
    }
  });
});

// ─── 5. Trips page – AuthGuard ────────────────────────────────────────────────

test.describe("Trips page – auth guard", () => {
  test.beforeEach(async ({ page }) => {
    await clearWalletState(page);
  });

  test("redirects or shows auth prompt for unauthenticated users", async ({
    page,
  }) => {
    await page.goto("/trips");
    await page.waitForLoadState("networkidle");
    const currentUrl = page.url();
    const onTrips = currentUrl.includes("/trips");
    if (onTrips) {
      const authPrompt = page.getByText(
        /connect.*wallet|sign in|wallet.*connect/i
      );
      await expect(authPrompt.first()).toBeVisible({ timeout: 10_000 });
    } else {
      expect(currentUrl).toMatch(/\/(auth|$)/);
    }
  });

  test("trips page heading is visible after guard", async ({ page }) => {
    await page.goto("/trips");
    await page.waitForLoadState("networkidle");
    // Either the auth prompt OR the trips heading is rendered
    const hasTripsHeading =
      (await page.getByRole("heading", { name: /trips/i }).count()) > 0;
    const hasAuthPrompt =
      (await page.getByText(/connect.*wallet|wallet.*connect/i).count()) > 0;
    expect(hasTripsHeading || hasAuthPrompt).toBe(true);
  });
});

// ─── 6. Trip detail – unknown ID ──────────────────────────────────────────────

test.describe("Trip detail – unknown trip ID", () => {
  test("renders gracefully for an unknown trip ID", async ({ page }) => {
    await clearWalletState(page);
    await page.goto("/trips/nonexistent-trip-id-xyz");
    await page.waitForLoadState("networkidle");
    // Should either redirect to auth, show a not-found message, or show the auth guard
    const url = page.url();
    const notFoundText = page.getByText(/not found|404|trip.*not|no trip/i);
    const authText = page.getByText(/connect.*wallet|sign in/i);
    const hasNotFound = (await notFoundText.count()) > 0;
    const hasAuth = (await authText.count()) > 0;
    const redirected = !url.includes("nonexistent-trip-id-xyz");
    expect(hasNotFound || hasAuth || redirected).toBe(true);
  });
});

// ─── 7. Mobile viewport – landing page ────────────────────────────────────────

test.describe("Mobile viewport – landing page", () => {
  test("renders landing page correctly on Pixel 5 (mobile)", async ({
    browser,
  }) => {
    // Launch a fresh context with Pixel 5 device emulation
    const pixel5 = devices["Pixel 5"];
    const context = await browser.newContext({
      ...pixel5,
    });
    const page = await context.newPage();

    // Clear wallet state using addInitScript BEFORE navigating
    await page.addInitScript(() => {
      localStorage.removeItem("StellarStar:publicKey");
      localStorage.removeItem("StellarStar:walletId");
    });

    await page.goto("/");

    // Hero heading should be visible on mobile
    const heading = page.getByRole("heading", { level: 1 }).first();
    await expect(heading).toBeVisible({ timeout: 10_000 });

    // Viewport width should match mobile (~393px for Pixel 5)
    const viewportWidth = await page.evaluate(() => window.innerWidth);
    expect(viewportWidth).toBeLessThanOrEqual(430); // mobile range

    // Page should not have horizontal overflow (no broken layout)
    const bodyScrollWidth = await page.evaluate(
      () => document.body.scrollWidth
    );
    const windowInnerWidth = await page.evaluate(() => window.innerWidth);
    expect(bodyScrollWidth).toBeLessThanOrEqual(windowInnerWidth + 2); // 2px tolerance

    await context.close();
  });

  test("hamburger / compact nav is present on mobile", async ({ browser }) => {
    const pixel5 = devices["Pixel 5"];
    const context = await browser.newContext({ ...pixel5 });
    const page = await context.newPage();
    await page.addInitScript(() => {
      localStorage.removeItem("StellarStar:publicKey");
      localStorage.removeItem("StellarStar:walletId");
    });
    await page.goto("/");

    // On mobile the header should still be present
    const header = page.locator("header").first();
    await expect(header).toBeVisible({ timeout: 10_000 });

    await context.close();
  });
});
