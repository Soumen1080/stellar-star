/**
 * __tests__/security/requiredIdempotencyKeys.test.ts
 *
 * Issue #412: Require idempotency keys for public mutations.
 *
 * Verifies:
 *  1. The key contract: absent → 400 IDEMPOTENCY_KEY_REQUIRED; too short, too
 *     long, whitespace, control or non-ASCII, or conflicting sources → 400
 *     IDEMPOTENCY_KEY_INVALID.
 *  2. The store wrapper never executes a mutation without a valid key.
 *  3. The route wrapper replays the original 2xx status and body, releases
 *     the key after a failed attempt, and answers misuse with 409.
 *  4. Real routes reject a missing key before doing any work and replay
 *     retries without re-running the mutation.
 *  5. Every mutating handler under app/api is either required or explicitly
 *     exempt (with a documented reason), and required routes use the wrapper.
 */

import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  IDEMPOTENCY_KEY_MAX_LENGTH,
  IDEMPOTENCY_KEY_MIN_LENGTH,
  readIdempotencyKey,
  validateIdempotencyKey,
} from "@/lib/idempotency/key";
import {
  IdempotencyKeyError,
  __resetIdempotencyForTests,
  claimIdempotencyKey,
  computeRequestFingerprint,
  withIdempotency,
} from "@/lib/idempotency/store";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import {
  IDEMPOTENCY_EXEMPT_ROUTES,
  IDEMPOTENCY_REQUIRED_ROUTES,
  requiresIdempotencyKey,
  type MutatingMethod,
} from "@/lib/idempotency/policy";
import {
  createIdempotencyKeyHolder,
  isIdempotencyConflict,
  newIdempotencyKey,
} from "@/lib/idempotency/client";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import * as claimLib from "@/lib/invitations/claim";
import * as supabaseServer from "@/lib/supabase/server";
import { POST as claimInviteRoute } from "@/app/api/invitations/claim/route";
import { POST as v1CreateTrip } from "@/app/api/v1/trips/route";
import { generateScopedToken, clearTokenStore } from "@/lib/api/tokens";
import { clearSandboxData } from "@/lib/api/data";
import { clearAuditLogs } from "@/lib/api/middleware";
import { __resetRateLimitsForTests } from "@/lib/auth/rateLimiter";

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";

function headers(entries: Record<string, string>) {
  return new Headers(entries);
}

beforeEach(() => {
  __resetIdempotencyForTests();
  __resetRateLimitsForTests();
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ─── 1. Key contract ──────────────────────────────────────────────────────────

describe("validateIdempotencyKey", () => {
  it.each([undefined, null, ""])("reports %p as required", (value) => {
    const result = validateIdempotencyKey(value);
    expect(result).toEqual(expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" }));
  });

  it("accepts a UUID and prefixed keys", () => {
    for (const key of [crypto.randomUUID(), `copy_${crypto.randomUUID()}`, "approve:1234-abcd", "req-idem-1"]) {
      expect(validateIdempotencyKey(key)).toEqual({ ok: true, key });
    }
  });

  it("enforces the length bounds exactly", () => {
    expect(validateIdempotencyKey("a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH)).ok).toBe(true);
    expect(validateIdempotencyKey("a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH)).ok).toBe(true);

    for (const key of ["a".repeat(IDEMPOTENCY_KEY_MIN_LENGTH - 1), "a".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)]) {
      expect(validateIdempotencyKey(key)).toEqual(
        expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }),
      );
    }
  });

  it.each([
    ["an inner space", "abc def-123"],
    ["surrounding whitespace", " abcdefgh-1 "],
    ["a tab", "abcdefgh\t1"],
    ["a newline", "abcdefgh\n1"],
    ["a NUL byte", "abcdefgh\u00001"],
    ["non-ASCII", "clé-idempotence"],
    ["an emoji", "key-💸-12345"],
  ])("rejects a key containing %s", (_label, key) => {
    expect(validateIdempotencyKey(key)).toEqual(
      expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }),
    );
  });

  it("rejects non-string values", () => {
    expect(validateIdempotencyKey(12345678 as unknown)).toEqual(
      expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }),
    );
  });
});

describe("readIdempotencyKey", () => {
  it("reads the canonical header case-insensitively", () => {
    expect(readIdempotencyKey(headers({ "idempotency-key": "header-key-1" }))).toEqual({
      ok: true,
      key: "header-key-1",
    });
  });

  it("accepts the X-Idempotency-Key alias", () => {
    expect(readIdempotencyKey(headers({ "x-idempotency-key": "alias-key-1" }))).toEqual({
      ok: true,
      key: "alias-key-1",
    });
  });

  it("only reads a body key when the route opts in", () => {
    const body = { idempotencyKey: "body-key-123" };
    expect(readIdempotencyKey(headers({}), body)).toEqual({ ok: true, key: "body-key-123" });
    expect(readIdempotencyKey(headers({}))).toEqual(
      expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_REQUIRED" }),
    );
  });

  it("accepts agreeing sources and rejects disagreeing ones", () => {
    expect(
      readIdempotencyKey(headers({ "idempotency-key": "same-key-1" }), { idempotencyKey: "same-key-1" }),
    ).toEqual({ ok: true, key: "same-key-1" });

    expect(
      readIdempotencyKey(headers({ "idempotency-key": "key-one-111", "x-idempotency-key": "key-two-222" })),
    ).toEqual(expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }));

    expect(
      readIdempotencyKey(headers({ "idempotency-key": "key-one-111" }), { idempotencyKey: "key-two-222" }),
    ).toEqual(expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }));
  });

  it("rejects a repeated header, which arrives comma-joined", () => {
    const h = new Headers();
    h.append("idempotency-key", "key-one-111");
    h.append("idempotency-key", "key-two-222");
    expect(readIdempotencyKey(h)).toEqual(expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }));
  });

  it("rejects a non-string body key", () => {
    expect(readIdempotencyKey(headers({}), { idempotencyKey: 42 })).toEqual(
      expect.objectContaining({ ok: false, code: "IDEMPOTENCY_KEY_INVALID" }),
    );
  });
});

describe("requireIdempotencyKey", () => {
  it("answers a missing key with a flat 400 by default", async () => {
    const result = requireIdempotencyKey({ headers: headers({}) });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("cache-control")).toBe("no-store");
    expect(await result.response.json()).toEqual({
      error: expect.stringContaining("Idempotency-Key"),
      code: "IDEMPOTENCY_KEY_REQUIRED",
    });
  });

  it("uses the v1 error envelope when asked", async () => {
    const result = requireIdempotencyKey({ headers: headers({ "idempotency-key": "short" }) }, { format: "v1" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(await result.response.json()).toEqual({
      error: { code: "IDEMPOTENCY_KEY_INVALID", message: expect.any(String), status: 400 },
    });
  });
});

// ─── 2. Store wrapper ─────────────────────────────────────────────────────────

describe("withIdempotency requires a key", () => {
  it.each([null, "", "short", "has space here", "x".repeat(256)])(
    "throws IdempotencyKeyError for %p without executing",
    async (key) => {
      const execute = jest.fn(async () => ({ data: { ok: true }, status: 201 }));
      await expect(
        withIdempotency({ key, walletAddress: WALLET, endpoint: "/api/expenses", payload: {}, execute }),
      ).rejects.toBeInstanceOf(IdempotencyKeyError);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("reports the error as a 400 with a stable code", async () => {
    try {
      await withIdempotency({
        key: null,
        walletAddress: WALLET,
        endpoint: "/api/expenses",
        payload: {},
        execute: async () => ({ data: null, status: 201 }),
      });
      throw new Error("expected IdempotencyKeyError");
    } catch (err) {
      expect(err).toBeInstanceOf(IdempotencyKeyError);
      expect((err as IdempotencyKeyError).status).toBe(400);
      expect((err as IdempotencyKeyError).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    }
  });
});

// ─── 3. Route wrapper semantics ───────────────────────────────────────────────

function mutationRequest(url = "http://localhost/api/expenses/e-1/void", method = "POST") {
  return new NextRequest(url, { method });
}

describe("runIdempotentMutation", () => {
  it("runs once and replays the original status and body", async () => {
    const request = mutationRequest();
    const execute = jest.fn(async () => NextResponse.json({ data: { id: "exp-1" } }, { status: 201 }));
    const options = { request, key: "replay-key-1", replayFields: ["data"], principal: WALLET, payload: { reason: "dup" }, execute };

    const first = await runIdempotentMutation(options);
    const second = await runIdempotentMutation(options);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(201);
    expect(first.headers.get("Idempotent-Replayed")).toBeNull();
    expect(second.status).toBe(201);
    expect(second.headers.get("Idempotent-Replayed")).toBe("true");
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(await second.json()).toEqual(await first.json());
  });

  it("adds replay headers to a replayed response", async () => {
    const options = {
      request: mutationRequest(),
      key: "replay-headers-1", replayFields: ["ok"],
      principal: WALLET,
      payload: {},
      replayHeaders: { "Cache-Control": "no-store, private", "X-Request-Id": "req-1" },
      execute: async () => NextResponse.json({ ok: true }),
    };
    await runIdempotentMutation(options);
    const replay = await runIdempotentMutation(options);
    expect(replay.headers.get("cache-control")).toBe("no-store, private");
    expect(replay.headers.get("x-request-id")).toBe("req-1");
  });

  it("replays an empty 204 as an empty 204", async () => {
    const options = {
      request: mutationRequest("http://localhost/api/receipts/r-1", "DELETE"),
      key: "no-content-1", replayFields: [],
      principal: WALLET,
      payload: {},
      execute: async () => new NextResponse(null, { status: 204 }),
    };
    await runIdempotentMutation(options);
    const replay = await runIdempotentMutation(options);
    expect(replay.status).toBe(204);
    expect(await replay.text()).toBe("");
  });

  it("does not store a failed attempt, so the same key can retry", async () => {
    let attempt = 0;
    const execute = jest.fn(async () => {
      attempt += 1;
      return attempt === 1
        ? NextResponse.json({ error: "Reason too short." }, { status: 400 })
        : NextResponse.json({ data: "voided" }, { status: 200 });
    });
    const base = { request: mutationRequest(), key: "retry-after-fail", replayFields: ["data"], principal: WALLET, execute };

    const failed = await runIdempotentMutation({ ...base, payload: { reason: "x" } });
    expect(failed.status).toBe(400);
    expect(await failed.json()).toEqual({ error: "Reason too short." });

    // The user fixes the payload and retries with the same key: allowed,
    // because the failed attempt released its claim.
    const fixed = await runIdempotentMutation({ ...base, payload: { reason: "Duplicate charge" } });
    expect(fixed.status).toBe(200);
    expect(fixed.headers.get("Idempotent-Replayed")).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("releases the claim when the handler throws", async () => {
    const options = {
      request: mutationRequest(),
      key: "throwing-handler", replayFields: ["ok"],
      principal: WALLET,
      payload: {},
      execute: jest.fn(async (): Promise<Response> => {
        throw new Error("database down");
      }),
    };
    await expect(runIdempotentMutation(options)).rejects.toThrow("database down");
    options.execute.mockImplementation(async () => NextResponse.json({ ok: true }));
    const retry = await runIdempotentMutation(options);
    expect(retry.status).toBe(200);
  });

  it("answers a reused key with a different payload with 409 IDEMPOTENCY_CONFLICT", async () => {
    const base = {
      request: mutationRequest(),
      key: "conflict-key-1", replayFields: ["ok"],
      principal: WALLET,
      execute: async () => NextResponse.json({ ok: true }, { status: 201 }),
    };
    await runIdempotentMutation({ ...base, payload: { amount: "10.00" } });
    const conflict = await runIdempotentMutation({ ...base, payload: { amount: "99.00" } });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: expect.any(String), code: "IDEMPOTENCY_CONFLICT" });
  });

  it("treats the same key on another endpoint as a conflict, never a cross-route replay", async () => {
    const base = { key: "cross-route-1", replayFields: ["voided"], principal: WALLET, payload: {} };
    await runIdempotentMutation({
      ...base,
      request: mutationRequest("http://localhost/api/expenses/a/void"),
      execute: async () => NextResponse.json({ voided: "a" }),
    });
    const other = await runIdempotentMutation({
      ...base,
      request: mutationRequest("http://localhost/api/expenses/b/void"),
      execute: async () => NextResponse.json({ voided: "b" }),
    });
    expect(other.status).toBe(409);
  });

  it("scopes keys to the principal", async () => {
    const execute = jest.fn(async () => NextResponse.json({ ok: true }, { status: 201 }));
    const base = { request: mutationRequest(), key: "shared-key-1", replayFields: ["ok"], payload: {}, execute };
    await runIdempotentMutation({ ...base, principal: WALLET });
    const other = await runIdempotentMutation({ ...base, principal: "GOTHERWALLET" });
    expect(other.headers.get("Idempotent-Replayed")).toBeNull();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("answers a concurrent duplicate with 409 IDEMPOTENCY_IN_PROGRESS and Retry-After", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const execute = jest.fn(async () => {
      await gate;
      return NextResponse.json({ ok: true }, { status: 201 });
    });
    const options = { request: mutationRequest(), key: "in-flight-key", replayFields: ["ok"], principal: WALLET, payload: {}, execute };

    const first = runIdempotentMutation(options);
    const second = await runIdempotentMutation(options);
    expect(second.status).toBe(409);
    expect(second.headers.get("retry-after")).toMatch(/^\d+$/);
    expect(await second.json()).toEqual({ error: expect.any(String), code: "IDEMPOTENCY_IN_PROGRESS" });

    release();
    expect((await first).status).toBe(201);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("runs a burst of parallel duplicates exactly once", async () => {
    const execute = jest.fn(async () => NextResponse.json({ ok: true }, { status: 201 }));
    const options = { request: mutationRequest(), key: "burst-key-1", replayFields: ["ok"], principal: WALLET, payload: {}, execute };
    const results = await Promise.all(Array.from({ length: 10 }, () => runIdempotentMutation(options)));
    expect(execute).toHaveBeenCalledTimes(1);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(9);
  });

  it("uses the v1 envelope for conflicts when asked", async () => {
    const base = {
      request: mutationRequest("http://localhost/api/v1/trips"),
      key: "v1-conflict-1", replayFields: ["ok"],
      principal: WALLET,
      format: "v1" as const,
      execute: async () => NextResponse.json({ ok: true }, { status: 201 }),
    };
    await runIdempotentMutation({ ...base, payload: { name: "A" } });
    const conflict = await runIdempotentMutation({ ...base, payload: { name: "B" } });
    expect(await conflict.json()).toEqual({
      error: { code: "IDEMPOTENCY_CONFLICT", message: expect.any(String), status: 409 },
    });
  });

  it("never touches the database ledger when persist is false", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: null }));
    const client = { rpc, from: jest.fn() } as any;
    const options = {
      request: mutationRequest("http://localhost/api/v1/tokens"),
      key: "secret-bearing-1", replayFields: ["data.token"],
      principal: WALLET,
      payload: {},
      client,
      persist: false,
      execute: async () => NextResponse.json({ data: { token: "stk_live_secret" } }, { status: 201 }),
    };
    await runIdempotentMutation(options);
    const replay = await runIdempotentMutation(options);
    expect(replay.headers.get("Idempotent-Replayed")).toBe("true");
    expect(rpc).not.toHaveBeenCalled();
    expect(client.from).not.toHaveBeenCalled();
  });

  it("stores the completed response in the durable ledger when persisting", async () => {
    const rpc = jest.fn(async (fn: string, _args: Record<string, unknown>) =>
      fn === "claim_idempotency_key" ? { data: { outcome: "new_claim" }, error: null } : { data: null, error: null },
    );
    const client = { rpc } as any;
    await runIdempotentMutation({
      request: mutationRequest(),
      key: "durable-key-1", replayFields: ["data"],
      principal: WALLET,
      payload: { reason: "dup" },
      client,
      execute: async () => NextResponse.json({ data: "voided" }),
    });
    expect(rpc).toHaveBeenCalledWith("claim_idempotency_key", expect.objectContaining({ p_key: "durable-key-1" }));
    expect(rpc).toHaveBeenCalledWith(
      "complete_idempotency_key",
      expect.objectContaining({ p_key: "durable-key-1", p_response_status: 200, p_response_body: { data: "voided" } }),
    );
  });

  it("binds the fingerprint to method and path", async () => {
    const execute = jest.fn(async () => NextResponse.json({ ok: true }));
    await runIdempotentMutation({
      request: mutationRequest("http://localhost/api/reminders/schedules", "DELETE"),
      key: "fingerprint-key", replayFields: ["ok"],
      principal: WALLET,
      payload: { scheduleId: "s-1" },
      execute,
    });
    const claim = await claimIdempotencyKey({
      walletAddress: WALLET,
      key: "fingerprint-key",
      endpoint: "DELETE /api/reminders/schedules",
      fingerprint: computeRequestFingerprint(WALLET, "DELETE /api/reminders/schedules", { scheduleId: "s-1" }),
    });
    expect(claim.outcome).toBe("completed_replay");
  });
});

// ─── 4. Real routes ───────────────────────────────────────────────────────────

describe("POST /api/invitations/claim enforces the key", () => {
  const session = signWalletSession(WALLET);

  beforeEach(() => {
    // The route builds an RLS client before claiming; no database is needed
    // here because claimTripInvite is stubbed per test.
    jest.spyOn(supabaseServer, "createServerClientForToken").mockReturnValue({} as any);
  });

  function claimRequest(key?: string | null) {
    return new NextRequest("http://localhost:3000/api/invitations/claim", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${session}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({ token: "tokyo-token", selectedMemberId: "m-bob" }),
    });
  }

  it("returns 400 without a key and claims nothing", async () => {
    const claim = jest.spyOn(claimLib, "claimTripInvite");
    const res = await claimInviteRoute(claimRequest(null));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(claim).not.toHaveBeenCalled();
  });

  it("returns 400 for an oversized key and claims nothing", async () => {
    const claim = jest.spyOn(claimLib, "claimTripInvite");
    const res = await claimInviteRoute(claimRequest("k".repeat(IDEMPOTENCY_KEY_MAX_LENGTH + 1)));
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe("IDEMPOTENCY_KEY_INVALID");
    expect(claim).not.toHaveBeenCalled();
  });

  it("still answers 401 before looking at the key", async () => {
    const res = await claimInviteRoute(
      new NextRequest("http://localhost:3000/api/invitations/claim", {
        method: "POST",
        body: JSON.stringify({ token: "tokyo-token" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("replays a successful claim to a retry without claiming again", async () => {
    const claim = jest.spyOn(claimLib, "claimTripInvite").mockResolvedValue({
      success: true,
      tripId: "trip-tokyo-2026",
      tripName: "Tokyo 2026",
      memberId: "m-bob",
      memberName: "Bob",
    } as any);
    const key = crypto.randomUUID();

    const first = await claimInviteRoute(claimRequest(key));
    const retry = await claimInviteRoute(claimRequest(key));

    expect(claim).toHaveBeenCalledTimes(1);
    expect(first.status).toBe(200);
    expect(retry.status).toBe(200);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect(await retry.json()).toEqual(await first.json());
  });

  it("lets a failed claim be retried with the same key", async () => {
    const claim = jest
      .spyOn(claimLib, "claimTripInvite")
      .mockRejectedValueOnce(new Error("Temporary failure"))
      .mockResolvedValueOnce({ success: true, tripId: "t", tripName: "T", memberId: "m", memberName: "M" } as any);
    const key = crypto.randomUUID();

    const failed = await claimInviteRoute(claimRequest(key));
    expect(failed.status).toBe(400);
    const retried = await claimInviteRoute(claimRequest(key));
    expect(retried.status).toBe(200);
    expect(retried.headers.get("Idempotent-Replayed")).toBeNull();
    expect(claim).toHaveBeenCalledTimes(2);
  });
});

describe("POST /api/v1/trips enforces the key", () => {
  const wallet = "G_IDEMPOTENCY_V1_WALLET_000000000000000000000";
  let token: string;

  beforeEach(() => {
    clearTokenStore();
    clearSandboxData();
    clearAuditLogs();
    token = generateScopedToken({ walletAddress: wallet, name: "Writer", scopes: ["trips:write", "trips:read"] }).token;
  });

  function createTrip(key?: string) {
    return new NextRequest("http://localhost/api/v1/trips", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      body: JSON.stringify({ name: "Lisbon", members: [{ name: "Ana" }] }),
    });
  }

  it("returns a v1-shaped 400 without a key", async () => {
    const res = await v1CreateTrip(createTrip());
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: { code: "IDEMPOTENCY_KEY_REQUIRED", message: expect.any(String), status: 400 },
    });
  });

  it("returns 400 for a too-short key", async () => {
    const res = await v1CreateTrip(createTrip("abc"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_INVALID");
  });

  it("still returns 401 for a missing token, ahead of the key check", async () => {
    const res = await v1CreateTrip(
      new NextRequest("http://localhost/api/v1/trips", { method: "POST", body: "{}" }),
    );
    expect(res.status).toBe(401);
  });

  it("creates one trip for a retried request and replays the 201", async () => {
    const key = crypto.randomUUID();
    const first = await v1CreateTrip(createTrip(key));
    const retry = await v1CreateTrip(createTrip(key));
    expect(first.status).toBe(201);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    expect((await retry.json()).data.id).toBe((await first.json()).data.id);
  });
});

// ─── 5. Route coverage ────────────────────────────────────────────────────────

const MUTATING: MutatingMethod[] = ["POST", "PUT", "PATCH", "DELETE"];
const APP_DIR = path.join(process.cwd(), "app");

function findRouteFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findRouteFiles(full));
    else if (entry.name === "route.ts" || entry.name === "route.tsx") out.push(full);
  }
  return out;
}

/** Mutating methods a route module exports, however it exports them. */
function exportedMutatingMethods(source: string): MutatingMethod[] {
  const found = new Set<MutatingMethod>();
  for (const method of MUTATING) {
    const declared = new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`);
    const assigned = new RegExp(`export\\s+(const|let|var)\\s+${method}\\b`);
    if (declared.test(source) || assigned.test(source)) found.add(method);
  }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    for (const part of match[1].split(",")) {
      const exported = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (exported && (MUTATING as string[]).includes(exported)) found.add(exported as MutatingMethod);
    }
  }
  return [...found];
}

const routes = findRouteFiles(path.join(APP_DIR, "api")).map((file) => {
  const route = "/" + path.relative(APP_DIR, path.dirname(file)).split(path.sep).join("/");
  const source = fs.readFileSync(file, "utf8");
  return { route, source, methods: exportedMutatingMethods(source) };
});

describe("every mutating route has an explicit idempotency decision", () => {
  it("finds the route tree", () => {
    expect(routes.length).toBeGreaterThan(20);
    expect(routes.some((r) => r.route === "/api/expenses" && r.methods.includes("POST"))).toBe(true);
  });

  it("classifies each mutating handler exactly once", () => {
    const problems: string[] = [];
    for (const { route, methods } of routes) {
      for (const method of methods) {
        const required = IDEMPOTENCY_REQUIRED_ROUTES[route]?.methods.includes(method) ?? false;
        const exempt = IDEMPOTENCY_EXEMPT_ROUTES[route]?.methods.includes(method) ?? false;
        if (required === exempt) {
          problems.push(`${method} ${route} is ${required ? "both required and exempt" : "unclassified"}`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("has no policy entries for handlers that do not exist", () => {
    const exported = new Map(routes.map((r) => [r.route, r.methods]));
    const stale: string[] = [];
    for (const table of [IDEMPOTENCY_REQUIRED_ROUTES, IDEMPOTENCY_EXEMPT_ROUTES]) {
      for (const [route, entry] of Object.entries(table)) {
        for (const method of entry.methods) {
          if (!exported.get(route)?.includes(method)) stale.push(`${method} ${route}`);
        }
      }
    }
    expect(stale).toEqual([]);
  });

  it("wires every required route through the key check and the claim", () => {
    const missing: string[] = [];
    for (const { route, source } of routes) {
      if (!IDEMPOTENCY_REQUIRED_ROUTES[route]) continue;
      if (!/requireIdempotencyKey(\(|:\s*true)/.test(source)) missing.push(`${route}: no key check`);
      if (!source.includes("runIdempotentMutation(")) missing.push(`${route}: no runIdempotentMutation`);
    }
    expect(missing).toEqual([]);
  });

  it("covers the issue's categories", () => {
    const required = (route: string, method: string) => requiresIdempotencyKey(route, method);
    expect(required("/api/expenses", "POST")).toBe(true); // financial
    expect(required("/api/settlement/attest", "POST")).toBe(true); // financial
    expect(required("/api/invitations/create", "POST")).toBe(true); // invitations
    expect(required("/api/expenses/[id]/receipts", "POST")).toBe(true); // receipts
    expect(required("/api/reminders/schedules", "POST")).toBe(true); // recurring work
    expect(required("/api/support/actions/approve", "POST")).toBe(true); // support
    expect(required("/api/recurring/run", "POST")).toBe(false); // documented cron exemption
  });

  it("documents a reason for every exemption", () => {
    for (const [route, entry] of Object.entries(IDEMPOTENCY_EXEMPT_ROUTES)) {
      expect(`${route}: ${entry.reason}`.length).toBeGreaterThan(route.length + 30);
    }
  });

  it("lists every required and exempt route in docs/IDEMPOTENCY.md", () => {
    const doc = fs.readFileSync(path.join(process.cwd(), "docs", "IDEMPOTENCY.md"), "utf8");
    const undocumented = [
      ...Object.keys(IDEMPOTENCY_REQUIRED_ROUTES),
      ...Object.keys(IDEMPOTENCY_EXEMPT_ROUTES),
    ].filter((route) => !doc.includes(`\`${route}\``));
    expect(undocumented).toEqual([]);
  });
});

// ─── Browser helpers ──────────────────────────────────────────────────────────

describe("lib/idempotency/client", () => {
  it("creates keys the server accepts", () => {
    for (let i = 0; i < 20; i += 1) {
      expect(validateIdempotencyKey(newIdempotencyKey()).ok).toBe(true);
    }
  });

  it("holds one key per action until reset", () => {
    const holder = createIdempotencyKeyHolder();
    const first = holder.current();
    expect(holder.current()).toBe(first);
    holder.reset();
    expect(holder.current()).not.toBe(first);
  });

  it("recognizes a conflict in both error formats", () => {
    expect(isIdempotencyConflict(409, { code: "IDEMPOTENCY_CONFLICT" })).toBe(true);
    expect(isIdempotencyConflict(409, { error: { code: "IDEMPOTENCY_CONFLICT" } })).toBe(true);
    expect(isIdempotencyConflict(409, { code: "IDEMPOTENCY_IN_PROGRESS" })).toBe(false);
    expect(isIdempotencyConflict(409, { code: "CONCURRENT_MODIFICATION" })).toBe(false);
    expect(isIdempotencyConflict(400, { code: "IDEMPOTENCY_CONFLICT" })).toBe(false);
    expect(isIdempotencyConflict(409, null)).toBe(false);
  });
});
