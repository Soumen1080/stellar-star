import { randomUUID } from "crypto";
import type { Page } from "@playwright/test";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { assertAccountLive, InfrastructureError, TestnetResetError, TESTNET_HORIZON_URL } from "./fixtures/network";

// Re-export for convenience in spec files
export { InfrastructureError, TestnetResetError, TESTNET_HORIZON_URL };

// ── Retry utility ──────────────────────────────────────────────────────────────

/**
 * Wraps an async operation with exponential back-off retry.
 *
 * Environmental noise (fetch timeouts, Horizon 503s, Friendbot rate-limits) is
 * retried silently. Assertion failures — wrong status codes, wrong field values
 * — propagate immediately so the test is marked FAILED rather than FLAKY.
 *
 * @param fn          - Async function to run
 * @param maxAttempts - Maximum total attempts (default 4)
 * @param baseDelayMs - Base delay for first retry in ms (default 1000; doubles each retry)
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = 4,
  baseDelayMs = 1_000
): Promise<T> {
  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      attempt++;
      // Always propagate assertion failures and testnet resets immediately
      if (err instanceof TestnetResetError) throw err;
      if (isAssertionError(err)) throw err;

      // Propagate if we've exhausted retries
      if (attempt >= maxAttempts) throw err;

      // Infrastructure noise: log a warning and retry with back-off
      const delay = baseDelayMs * Math.pow(2, attempt - 1);
      console.warn(
        `[withRetry] Attempt ${attempt}/${maxAttempts} failed (${String(err)}). ` +
          `Retrying in ${delay}ms…`
      );
      await sleep(delay);
    }
  }
}

/** Returns true for errors that indicate a real test assertion failure. */
function isAssertionError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const name = err.name ?? "";
  // Playwright assertion errors
  if (name === "AssertionError" || name.includes("Expect")) return true;
  // HTTP errors with a non-5xx status (e.g. 400 Bad Request = submission bug)
  if (err.message.includes("HTTP 4")) return true;
  // Stellar SDK errors with a result code that is our fault
  if (err.message.includes("tx_bad_auth") || err.message.includes("tx_invalid")) return true;
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Testnet reset guard ─────────────────────────────────────────────────────────

/**
 * Asserts that a testnet account is still alive (i.e. testnet has not been reset).
 *
 * Call at the start of live tests that rely on pre-provisioned accounts.
 * Throws TestnetResetError with an actionable message if the account is gone.
 * Throws InfrastructureError if Horizon is unreachable.
 */
export { assertAccountLive as assertNotTestnetReset };

/**
 * Injects a fake connected wallet so authenticated flows can be exercised
 * without a real Freighter extension. Signing happens in Node (this
 * process) via page.exposeFunction, using a real Stellar keypair, so the
 * app's server-side signature verification (app/api/auth/verify) is
 * exercised for real rather than stubbed out.
 *
 * Only takes effect when the app is served with NEXT_PUBLIC_E2E_TEST_MODE=true
 * (see playwright.config.ts) - see lib/stellar/e2eWallet.ts's getE2eTestWallet(),
 * which ignores the injected object unless that build flag is set.
 */
export async function mockWallet(page: Page, keypair: Keypair = Keypair.random()) {
  await page.exposeFunction("__e2eSignXDR__", async (xdr: string) => {
    const tx = TransactionBuilder.fromXDR(xdr, NETWORK_PASSPHRASE);
    tx.sign(keypair);
    return tx.toXDR();
  });

  const address = keypair.publicKey();
  await page.addInitScript((addr: string) => {
    (window as unknown as { __E2E_WALLET__: unknown }).__E2E_WALLET__ = {
      address: addr,
      signXDR: (xdr: string) => (window as unknown as { __e2eSignXDR__: (xdr: string) => Promise<string> }).__e2eSignXDR__(xdr),
    };
  }, address);

  return keypair;
}

/**
 * Intercepts Supabase PostgREST calls with a tiny in-memory fake so
 * authenticated flows (creating a user/trip/expense) work without a real
 * Supabase project. Each call gets its own isolated in-memory store, scoped
 * to the page it's installed on.
 */
export async function mockSupabaseBackend(page: Page) {
  const tables: Record<string, Record<string, unknown>[]> = {
    users: [],
    trips: [],
    expenses: [],
  };

  // Avoid noisy failed-reconnect spam from the realtime websocket, which
  // points at a fake host and can never succeed in this mocked setup.
  await page.routeWebSocket(/realtime\/v1/, (ws) => ws.close());

  await page.route("**/rest/v1/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const table = url.pathname.split("/").pop() || "";
    if (!(table in tables)) return route.continue();

    const wantsSingle = (request.headers()["accept"] || "").includes("vnd.pgrst.object");
    const filters: [string, string][] = [];
    url.searchParams.forEach((value, key) => {
      if (key === "select" || key === "order") return;
      const match = value.match(/^eq\.(.*)$/);
      if (match) filters.push([key, match[1]]);
    });
    const matches = (row: Record<string, unknown>) =>
      filters.every(([k, v]) => String(row[k]) === v);

    const respond = (status: number, body: unknown) =>
      route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });

    if (request.method() === "GET") {
      let rows = tables[table].filter(matches);
      const order = url.searchParams.get("order");
      if (order) {
        const [col, dir] = order.split(".");
        rows = [...rows].sort(
          (a, b) => ((a[col] as any) > (b[col] as any) ? 1 : -1) * (dir === "desc" ? -1 : 1)
        );
      }
      if (wantsSingle) {
        if (rows.length !== 1) return respond(406, { code: "PGRST116", message: "No rows found" });
        return respond(200, rows[0]);
      }
      return respond(200, rows);
    }

    if (request.method() === "POST") {
      const body = request.postDataJSON();
      const inserted = (Array.isArray(body) ? body : [body]).map((row) => ({
        id: randomUUID(),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...row,
      }));
      tables[table].push(...inserted);
      return respond(201, wantsSingle ? inserted[0] : inserted);
    }

    if (request.method() === "PATCH") {
      const body = request.postDataJSON();
      const updated: Record<string, unknown>[] = [];
      tables[table] = tables[table].map((row) => {
        if (!matches(row)) return row;
        const next = { ...row, ...body, updated_at: new Date().toISOString() };
        updated.push(next);
        return next;
      });
      return respond(200, wantsSingle ? updated[0] ?? {} : updated);
    }

    if (request.method() === "DELETE") {
      const removed = tables[table].filter(matches);
      tables[table] = tables[table].filter((row) => !matches(row));
      return respond(200, removed);
    }

    return route.continue();
  });
}

/** Connects the mock wallet and completes sign-up, landing on /dashboard. */
export async function signUpAndReachDashboard(page: Page, displayName = "Test User") {
  await page.goto("/auth", { waitUntil: "networkidle" });
  // In E2E mode, clicking "Connect Wallet" triggers a direct connection via
  // the injected __E2E_WALLET__ — no wallet-picker modal appears.
  await page.getByRole("button", { name: /connect wallet/i }).click();
  // Wait for the auth form to render after the wallet connects.
  await page.getByPlaceholder(/enter your full name/i).waitFor({ state: "visible", timeout: 10_000 });
  await page.getByPlaceholder(/enter your full name/i).fill(displayName);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/dashboard");
}
