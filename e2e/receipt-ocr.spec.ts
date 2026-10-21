import { test, expect } from "@playwright/test";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Keypair } from "@stellar/stellar-sdk";
import { mockSupabaseBackend, mockWallet } from "./helpers";

test("selected photo is reviewed, explicitly saved and retried without duplicating the expense", async ({ page }) => {
  const wallet = Keypair.random();
  const address = wallet.publicKey();
  const tables = await mockSupabaseBackend(page);
  const now = new Date().toISOString();
  tables.users.push({ id: randomUUID(), wallet_address: address, display_name: "Receipt Tester", created_at: now, updated_at: now, last_login_at: now });
  await mockWallet(page, wallet);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ sub: address, wallet_address: address, role: "authenticated", iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 86400 })).toString("base64url");
  const signature = createHmac("sha256", "e2e-test-only-jwt-secret-not-used-in-production").update(`${header}.${payload}`).digest("base64url");
  await page.addInitScript(({ address, token }) => {
    localStorage.setItem("StellarStar:publicKey", address);
    localStorage.setItem("StellarStar:authToken", token);
  }, { address, token: `${header}.${payload}.${signature}` });

  const png = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1000; canvas.height = 600;
    const context = canvas.getContext("2d")!;
    context.fillStyle = "white"; context.fillRect(0, 0, 1000, 600);
    context.fillStyle = "black"; context.font = "40px monospace";
    ["CAFE EXAMPLE", "2026-10-20", "Coffee 3.50", "Cake 4.00", "TOTAL XLM 7.50"].forEach((line, i) => context.fillText(line, 40, 80 + i * 90));
    return canvas.toDataURL("image/png").split(",")[1];
  });
  const original = Buffer.from(png, "base64");
  const originalChecksum = createHash("sha256").update(original).digest("hex");
  const uploadedChecksums: string[] = [];
  await page.exposeFunction("__observeReceiptUpload", (checksum: string) => uploadedChecksums.push(checksum));
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (/\/api\/expenses\/[^/]+\/receipts$/.test(url) && init?.body instanceof FormData) {
        const file = init.body.get("file");
        if (file instanceof Blob) {
          const hash = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
          const checksum = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
          await (window as unknown as { __observeReceiptUpload: (checksum: string) => Promise<void> }).__observeReceiptUpload(checksum);
        }
      }
      return originalFetch(input, init);
    };
  });
  await page.route("**/api/receipts/capabilities", (route) => route.fulfill({ json: { data: { maxBytes: 4194304 } } }));
  let uploadAttempts = 0;
  await page.route("**/api/expenses/*/receipts", async (route) => {
    if (route.request().method() !== "POST") return route.fulfill({ json: { data: [] } });
    uploadAttempts++;
    // Observe the actual browser FormData. WebKit's debugging protocol does not
    // preserve arbitrary binary bytes in request.postDataBuffer().
    expect(uploadedChecksums.at(-1)).toBe(originalChecksum);
    if (uploadAttempts === 1) return route.fulfill({ status: 502, json: { error: "Synthetic storage outage" } });
    return route.fulfill({ status: 201, json: { data: {
      id: randomUUID(), expenseId: tables.expenses[0].id, status: "active", fileName: "synthetic-receipt.png",
      contentType: "image/png", sizeBytes: original.length, checksum: createHash("sha256").update(original).digest("hex"),
      uploadedByWallet: address, createdAt: now, retainUntil: "2028-10-20T00:00:00Z", caption: null, removedAt: null,
    } } });
  });
  await page.goto("/expenses");
  await page.getByRole("button", { name: /new expense/i }).click();
  await page.getByRole("button", { name: "Capture or select a receipt" }).click();
  const camera = page.getByLabel("Capture receipt for draft");
  await expect(camera).toHaveAttribute("capture", "environment");
  await page.getByLabel("Select receipt for draft").setInputFiles({ name: "synthetic-receipt.png", mimeType: "image/png", buffer: original });
  await expect(page.getByAltText("Original receipt for field review")).toBeVisible();
  expect(tables.expenses).toHaveLength(0);
  await page.getByRole("button", { name: "Extract fields on this device" }).click();
  const apply = page.getByRole("button", { name: "Use reviewed receipt draft" });
  await expect(apply).toBeVisible({ timeout: 75_000 });
  await expect(page.getByLabel("Receipt merchant", { exact: true })).toHaveValue(/CAFE/);
  await expect(page.getByLabel("Receipt total", { exact: true })).toHaveValue("7.50");
  await expect(apply).toBeDisabled();
  // Correcting a suggestion is always explicit and requires confirmation again.
  await page.getByLabel("Receipt currency", { exact: true }).selectOption("XLM");
  for (const checkbox of await page.getByRole("checkbox").all()) await checkbox.check();
  await page.getByLabel("Receipt total", { exact: true }).fill("8.00");
  await expect(apply).toBeDisabled();
  await page.getByLabel("Receipt total", { exact: true }).fill("7.50");
  await page.getByLabel("I checked receipt total against the receipt").check();
  await apply.click();
  expect(tables.expenses).toHaveLength(0);
  await page.getByRole("textbox", { name: "Member 2 name", exact: true }).fill("Alex");
  await page.getByRole("button", { name: "Create Expense", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "original receipt was not attached" })).toBeVisible();
  expect(tables.expenses).toHaveLength(1);
  expect(tables.expenses[0].entered_amount).toBe("7.50");
  await page.getByRole("button", { name: "Retry receipt attachment" }).click();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeVisible();
  expect(tables.expenses).toHaveLength(1);
  expect(uploadAttempts).toBe(2);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
});
