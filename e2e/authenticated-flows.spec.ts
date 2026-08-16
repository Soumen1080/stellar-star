/**
 * Stellar-star – Authenticated Playwright flows
 *
 * The base e2e.spec.ts suite deliberately avoids wallet/Supabase
 * dependencies and only covers unauthenticated-state UI. This file uses a
 * test-mode wallet bypass (lib/stellar/walletsKit.ts, gated behind
 * NEXT_PUBLIC_E2E_TEST_MODE) plus an in-memory Supabase REST mock
 * (e2e/helpers.ts) to exercise the flows that require a signed-in wallet:
 * connecting, creating a trip, navigating to trip detail, creating an
 * expense, and viewing its payment QR code.
 */

import { test, expect } from "@playwright/test";
import { mockWallet, mockSupabaseBackend, signUpAndReachDashboard } from "./helpers";
import { Keypair } from "@stellar/stellar-sdk";

test.beforeEach(async ({ page }) => {
  await mockSupabaseBackend(page);
});

test("connects a wallet and signs up onto an empty dashboard", async ({ page }) => {
  await mockWallet(page);
  await signUpAndReachDashboard(page);

  await expect(page).toHaveURL(/\/dashboard/);
  await expect(page.getByRole("button", { name: /^connect wallet$/i })).toHaveCount(0);
});

test("creates a trip and navigates to its detail page", async ({ page }) => {
  const memberKeypair = Keypair.random();
  await mockWallet(page);
  await signUpAndReachDashboard(page);

  await page.goto("/trips");
  await page.getByRole("button", { name: /new trip/i }).first().click();

  await page.getByPlaceholder(/bali 2025/i).fill("Weekend Getaway");
  const memberNameInputs = page.getByPlaceholder(/member \d name/i);
  await memberNameInputs.nth(0).fill("Me");
  await memberNameInputs.nth(1).fill("Alex");
  const memberAddressInputs = page.getByPlaceholder(/stellar address/i);
  await memberAddressInputs.nth(1).fill(memberKeypair.publicKey());

  await page.getByRole("button", { name: /create trip/i }).click();

  const tripLink = page.getByRole("link", { name: /weekend getaway/i });
  await expect(tripLink).toBeVisible({ timeout: 10_000 });
  await tripLink.click();

  await expect(page).toHaveURL(/\/trips\/.+/);
  await expect(page.getByRole("heading", { name: /weekend getaway/i })).toBeVisible();
});

test("creates an expense in a trip and reveals its payment QR code", async ({ page }) => {
  const memberKeypair = Keypair.random();
  await mockWallet(page);
  await signUpAndReachDashboard(page);

  await page.goto("/trips");
  await page.getByRole("button", { name: /new trip/i }).first().click();
  await page.getByPlaceholder(/bali 2025/i).fill("Road Trip");
  const memberNameInputs = page.getByPlaceholder(/member \d name/i);
  await memberNameInputs.nth(0).fill("Me");
  await memberNameInputs.nth(1).fill("Sam");
  const memberAddressInputs = page.getByPlaceholder(/stellar address/i);
  await memberAddressInputs.nth(1).fill(memberKeypair.publicKey());
  await page.getByRole("button", { name: /create trip/i }).click();
  await page.getByRole("link", { name: /road trip/i }).click();
  await expect(page).toHaveURL(/\/trips\/.+/);

  // Creating expenses
  await page.getByRole("button", { name: /add expense/i }).click();
  await page.getByPlaceholder(/dinner at ramen soul/i).fill("Gas");
  await page.getByPlaceholder("10.5").fill("20");
  await page.getByRole("button", { name: /create expense/i }).click();

  const expenseRow = page.getByText("Gas", { exact: true });
  await expect(expenseRow).toBeVisible({ timeout: 10_000 });

  // Expand the expense card to reveal the per-member split and QR toggle.
  await expenseRow.click();

  // QR display
  const qrToggle = page.getByRole("button", { name: /qr code/i }).first();
  await expect(qrToggle).toBeVisible();
  await qrToggle.click();
  await expect(page.getByText(/scan to pay/i)).toBeVisible();
});
