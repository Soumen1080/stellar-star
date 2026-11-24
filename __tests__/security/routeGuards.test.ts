/**
 * __tests__/security/routeGuards.test.ts
 *
 * Issue #419: standardized authenticated route guards.
 *
 *  1. The guard: strict bearer parsing, verified wallet session, actor and
 *     request context, and a lazily created RLS client bound to the token.
 *  2. Static checks: no route builds a session client or verifies a token
 *     itself, and no user-request route imports the service-role client
 *     outside the documented privileged inventory.
 *  3. A generated matrix: every route using the guard, every exported handler.
 *     Anonymous, malformed, forged and expired credentials all get the same
 *     401 AUTH_REQUIRED, and no database client is created.
 */

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, createServiceRoleClient } from "@/lib/supabase/server";
import {
  AUTH_REQUIRED_CODE,
  authenticateWalletRequest,
  optionalWalletSession,
  readBearerToken,
} from "@/lib/api/routeGuard";

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: jest.fn(() => true),
  createServerClientForToken: jest.fn((token: string) => ({ kind: "rls", token })),
  createServiceRoleClient: jest.fn(() => ({ kind: "service" })),
  createServerAnonClient: jest.fn(() => ({ kind: "anon" })),
}));

const rlsClient = jest.mocked(createServerClientForToken);
const serviceClient = jest.mocked(createServiceRoleClient);

const ROOT = path.resolve(__dirname, "../..");
const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

function req(headers: Record<string, string> = {}, url = "http://localhost/api/x", init: { method?: string; body?: string } = {}) {
  return new NextRequest(url, { method: init.method ?? "GET", headers, body: init.body });
}

function forgedToken(): string {
  const saved = process.env.SUPABASE_JWT_SECRET;
  process.env.SUPABASE_JWT_SECRET = "an-attacker-chosen-secret-that-is-not-ours";
  const token = signWalletSession(WALLET);
  process.env.SUPABASE_JWT_SECRET = saved;
  return token;
}

const BAD_CREDENTIALS: Array<[string, () => Record<string, string>]> = [
  ["anonymous", () => ({})],
  ["wrong scheme", () => ({ authorization: `Basic ${Buffer.from("a:b").toString("base64")}` })],
  ["lowercase scheme", () => ({ authorization: `bearer ${signWalletSession(WALLET)}` })],
  ["garbage token", () => ({ authorization: "Bearer not-a-jwt" })],
  ["two tokens", () => ({ authorization: `Bearer ${signWalletSession(WALLET)} ${signWalletSession(WALLET)}` })],
  ["oversized token", () => ({ authorization: `Bearer ${"a".repeat(3000)}.${"b".repeat(1500)}.c` })],
  ["forged signature", () => ({ authorization: `Bearer ${forgedToken()}` })],
  ["expired session", () => ({ authorization: `Bearer ${signWalletSession(WALLET, WALLET, -60)}` })],
  ["alg none", () => {
    const head = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(JSON.stringify({ wallet_address: WALLET, exp: 9999999999 })).toString("base64url");
    return { authorization: `Bearer ${head}.${body}.sig` };
  }],
];

beforeEach(() => {
  rlsClient.mockClear();
  serviceClient.mockClear();
});

// ─── 1. The guard ─────────────────────────────────────────────────────────────

describe("authenticateWalletRequest", () => {
  it("attaches actor, claims and request id, and builds the RLS client only on first use", () => {
    const token = signWalletSession(WALLET);
    const result = authenticateWalletRequest(req({ authorization: `Bearer ${token}`, "x-request-id": "11111111-2222-4333-8444-555555555555" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ctx.actor).toEqual({ kind: "wallet", wallet: WALLET, subject: WALLET });
    expect(result.ctx.requestId).toBe("11111111-2222-4333-8444-555555555555");
    expect(rlsClient).not.toHaveBeenCalled();
    const db = result.ctx.db();
    expect(result.ctx.db()).toBe(db);
    expect(rlsClient).toHaveBeenCalledTimes(1);
    expect(rlsClient).toHaveBeenCalledWith(token);
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("dbIfConfigured returns null when the server database is not configured", () => {
    const { isServerSupabaseConfigured } = jest.requireMock("@/lib/supabase/server");
    isServerSupabaseConfigured.mockReturnValueOnce(false);
    const result = authenticateWalletRequest(req({ authorization: `Bearer ${signWalletSession(WALLET)}` }));
    expect(result.ok && result.ctx.dbIfConfigured()).toBeNull();
    expect(rlsClient).not.toHaveBeenCalled();
  });

  it.each(BAD_CREDENTIALS)("refuses %s with the same 401 shape", async (_label, headers) => {
    const result = authenticateWalletRequest(req({ ...headers(), "x-request-id": "rid-1" }), { message: "Sign in." });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect(result.response.headers.get("www-authenticate")).toMatch(/^Bearer/);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(await result.response.json()).toEqual({ error: "Sign in.", code: AUTH_REQUIRED_CODE, requestId: expect.any(String) });
    expect(rlsClient).not.toHaveBeenCalled();
  });

  it("parses only a strict bearer header", () => {
    const token = signWalletSession(WALLET);
    expect(readBearerToken(new Headers({ authorization: `Bearer ${token}` }))).toBe(token);
    expect(readBearerToken(new Headers({ authorization: `Bearer  ${token} ` }))).toBe(token);
    expect(readBearerToken(new Headers({ authorization: `Bearer${token}` }))).toBeNull();
    expect(readBearerToken(new Headers({}))).toBeNull();
  });

  it("optionalWalletSession: absent is anonymous, present-but-invalid is refused, valid is attached", () => {
    expect(optionalWalletSession(req())).toEqual({ ok: true, ctx: null });
    const bad = optionalWalletSession(req({ authorization: "Bearer junk" }));
    expect(bad.ok).toBe(false);
    const good = optionalWalletSession(req({ authorization: `Bearer ${signWalletSession(WALLET)}` }));
    expect(good.ok && good.ctx?.actor.wallet).toBe(WALLET);
  });
});

// ─── 2. Static checks ─────────────────────────────────────────────────────────

function routeFiles(dir = path.join(ROOT, "app/api")): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name === "route.ts" ? [full] : [];
  });
}

const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
const source = (file: string) => fs.readFileSync(file, "utf8");

/**
 * Routes allowed to touch the service-role client, each with its reason.
 * Mirrors docs/AUTHORIZATION_MATRIX.md §4.2. Adding a user-request route
 * here needs a security review.
 */
const SERVICE_ROLE_ROUTES: Record<string, string> = {
  "app/api/auth/verify/route.ts": "SR-01: provisions the profile after a verified signature",
  "app/api/invitations/verify/route.ts": "SR-02: resolves one hashed invite capability for a preview",
  "app/api/recurring/run/route.ts": "SR-03: cron secret",
  "app/api/receipts/retention/route.ts": "SR-04: cron secret",
  "app/api/account/delete/route.ts": "SR-08: owner-verified account deletion",
  "app/api/settlement/reconciliation-worker/route.ts": "SR-09: cron or explicit staff only",
  "app/api/settlement/reconciliation-worker/cron/route.ts": "SR-09: cron secret",
  "app/api/idempotency/cleanup/route.ts": "SR-10: cron secret",
  "app/api/outbox/worker/route.ts": "SR-11: cron secret",
  "app/api/reminders/run/route.ts": "SR-12: cron secret",
  "app/api/reminders/unsubscribe/route.ts": "SR-13: signed unsubscribe capability, no session",
  "app/api/support/lookup/route.ts": "SR-14: staff credentials",
  "app/api/support/audit-logs/route.ts": "SR-14: staff credentials",
  "app/api/support/actions/route.ts": "SR-14: staff credentials",
  "app/api/support/actions/propose/route.ts": "SR-14: staff credentials, dual control",
  "app/api/support/actions/approve/route.ts": "SR-14: staff credentials, dual control",
};

/** Routes that issue or renew sessions, or authenticate non-wallet actors, themselves. */
const OWN_AUTH_ROUTES: Record<string, string> = {
  "app/api/auth/verify/route.ts": "issues the session from a signed challenge",
  "app/api/auth/refresh/route.ts": "renews a session; refreshWalletSession verifies it",
  "app/api/settlement/reconciliation-worker/route.ts": "cron/staff/wallet actors via lib/settlement/reconciliationAuth",
};

describe("static route checks", () => {
  const files = routeFiles();

  it("no route verifies sessions or builds session clients itself", () => {
    const offenders = files
      .filter((f) => !OWN_AUTH_ROUTES[rel(f)])
      .filter((f) => /\b(verifyWalletSession|createServerClientForToken)\s*\(/.test(source(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no route parses the Authorization header for a wallet session by hand", () => {
    const offenders = files
      .filter((f) => !OWN_AUTH_ROUTES[rel(f)])
      .filter((f) => /authorization[^\n]*\n[^\n]*startsWith\("Bearer "\)[^\n]*\n[^\n]*verifyWalletSession/.test(source(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("the service-role client is used only by documented privileged routes", () => {
    const offenders = files
      .filter((f) => /createServiceRoleClient/.test(source(f)))
      .map(rel)
      .filter((f) => !SERVICE_ROLE_ROUTES[f]);
    expect(offenders).toEqual([]);
  });

  it("routes using the guard never also import the service-role client (except SR-08)", () => {
    const offenders = files
      .filter((f) => /authenticateWalletRequest|optionalWalletSession/.test(source(f)))
      .filter((f) => /createServiceRoleClient/.test(source(f)))
      .map(rel)
      .filter((f) => f !== "app/api/account/delete/route.ts");
    expect(offenders).toEqual([]);
  });

  it("every privileged route is listed in the authorization matrix", () => {
    const matrix = fs.readFileSync(path.join(ROOT, "docs/AUTHORIZATION_MATRIX.md"), "utf8");
    for (const [file, reason] of Object.entries(SERVICE_ROLE_ROUTES)) {
      const id = reason.split(":")[0];
      expect({ file, documented: matrix.includes(`**${id}**`) }).toEqual({ file, documented: true });
    }
  });
});

// ─── 3. Generated authorization matrix ───────────────────────────────────────

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;

const guarded = routeFiles()
  .filter((f) => /authenticateWalletRequest\(/.test(source(f)))
  .flatMap((f) => {
    const src = source(f);
    // Only handlers whose own body calls the guard (a file may also export a public GET).
    const sections = src.split(/(?=export async function )/);
    return METHODS.filter((m) =>
      sections.some((sec) => new RegExp(`^export async function ${m}\\b`).test(sec) && /authenticateWalletRequest\(/.test(sec)),
    ).map((m) => [rel(f), m] as const);
  });

describe("every guarded handler refuses bad credentials identically", () => {
  it("finds the guarded routes", () => {
    expect(guarded.length).toBeGreaterThanOrEqual(20);
  });

  const params = { id: "00000000-0000-4000-8000-000000000001", memberId: "member-1" };

  describe.each(guarded)("%s %s", (file, method) => {
    it.each(BAD_CREDENTIALS)("%s → 401 AUTH_REQUIRED, no database client", async (_label, headers) => {
      jest.spyOn(console, "error").mockImplementation(() => {});
      jest.spyOn(console, "warn").mockImplementation(() => {});
      const mod = require(path.join(ROOT, file)) as Record<string, (r: NextRequest, c: unknown) => Promise<Response>>;
      const url = `http://localhost/${file.replace(/^app\//, "").replace(/\/route\.ts$/, "")}`;
      const hasBody = method !== "GET" && method !== "DELETE";
      const request = req(
        { ...headers(), ...(hasBody ? { "content-type": "application/json" } : {}), "idempotency-key": "matrix-key-0001" },
        url,
        { method, body: hasBody ? JSON.stringify({ tripId: params.id, name: "x", invitee: WALLET, account: WALLET }) : undefined },
      );
      const res = await mod[method](request, { params: Promise.resolve(params) });
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe(AUTH_REQUIRED_CODE);
      expect(rlsClient).not.toHaveBeenCalled();
      expect(serviceClient).not.toHaveBeenCalled();
    });
  });
});
