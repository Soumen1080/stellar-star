import { randomUUID } from "crypto";
import type { Page } from "@playwright/test";
import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

/**
 * Injects a fake connected wallet so authenticated flows can be exercised
 * without a real Freighter extension. Signing happens in Node (this
 * process) via page.exposeFunction, using a real Stellar keypair, so the
 * app's server-side signature verification (app/api/auth/verify) is
 * exercised for real rather than stubbed out.
 *
 * Only takes effect when the app is served with NEXT_PUBLIC_E2E_TEST_MODE=true
 * (see playwright.config.ts) - see lib/stellar/walletsKit.ts's e2eTestWallet().
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
  await page.getByRole("button", { name: /connect wallet/i }).click();
  await page.getByRole("button", { name: /freighter/i }).click();
  await page.getByPlaceholder(/enter your full name/i).fill(displayName);
  await page.getByRole("button", { name: /create account/i }).click();
  await page.waitForURL("**/dashboard");
}
