/**
 * __tests__/security/idempotencyRetention.test.ts
 *
 * Issue #414: Expire and redact idempotency response data.
 *
 * Verifies:
 *  1. Only allowlisted fields are persisted; everything else in a response
 *     (free text, secrets, personal data, internal fields) is dropped.
 *  2. A SHA-256 digest of the full original body is kept and exposed.
 *  3. Summaries over the 16 KiB cap are not stored; a retry gets the original
 *     status with an explicit "body omitted" marker instead of re-running.
 *  4. Replay works only inside the documented window; afterwards the key is
 *     free again. Abandoned and expired records are swept, and the
 *     process-local ledger is bounded.
 *  5. The cleanup path is cron-authenticated and batched through indexes.
 *  6. Every required route declares a deliberate replay allowlist.
 */

import fs from "fs";
import path from "path";
import { NextRequest, NextResponse } from "next/server";
import {
  EXPENSE_REPLAY_FIELDS,
  buildStoredReplay,
  digestResponseBody,
  summarizeForReplay,
} from "@/lib/idempotency/replay";
import {
  IDEMPOTENCY_AUDIT_RETENTION_DAYS,
  IDEMPOTENCY_MAX_MEMORY_RECORDS,
  IDEMPOTENCY_MAX_REPLAY_BYTES,
  IDEMPOTENCY_REPLAY_TTL_SECONDS,
} from "@/lib/idempotency/retention";
import {
  __resetIdempotencyForTests,
  atomicClaimInMemory,
  completeIdempotencyClaim,
  sweepIdempotencyMemory,
} from "@/lib/idempotency/store";
import { IDEMPOTENCY_DIGEST_HEADER, runIdempotentMutation } from "@/lib/idempotency/route";
import { IDEMPOTENCY_REQUIRED_ROUTES } from "@/lib/idempotency/policy";
import { purgeIdempotencyRecords } from "@/lib/idempotency/cleanup";
import { GET as cleanupRoute } from "@/app/api/idempotency/cleanup/route";

const WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const ROOT = process.cwd();

beforeEach(() => {
  __resetIdempotencyForTests();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

function request(url = "http://localhost/api/expenses/e-1/void") {
  return new NextRequest(url, { method: "POST" });
}

// ─── 1. Allowlisted summaries ─────────────────────────────────────────────────

describe("summarizeForReplay", () => {
  it("keeps only named fields, including nested and array element fields", () => {
    const body = {
      data: {
        id: "exp-1",
        title: "Dinner",
        description: "Private note about who owes what",
        members: [
          { id: "m1", name: "Ana", email: "ana@example.com" },
          { id: "m2", name: "Bo", email: "bo@example.com" },
        ],
      },
      internalTrace: { sql: "select *" },
    };
    expect(summarizeForReplay(body, ["data.id", "data.title", "data.members[].id", "data.members[].name"])).toEqual({
      data: {
        id: "exp-1",
        title: "Dinner",
        members: [
          { id: "m1", name: "Ana" },
          { id: "m2", name: "Bo" },
        ],
      },
    });
  });

  it("keeps a whole subtree when the path names it", () => {
    const body = { attestation: { claim: { a: 1 }, signatures: [{ s: "x" }] }, extra: true };
    expect(summarizeForReplay(body, ["attestation"])).toEqual({ attestation: body.attestation });
  });

  it("lets a broader path win over a narrower one, in either order", () => {
    const body = { a: { b: 1, c: 2 }, d: 3 };
    expect(summarizeForReplay(body, ["a", "a.b"])).toEqual({ a: { b: 1, c: 2 } });
    expect(summarizeForReplay(body, ["a.b", "a"])).toEqual({ a: { b: 1, c: 2 } });
  });

  it("stores nothing for an empty allowlist or a non-object body", () => {
    expect(summarizeForReplay({ secret: "x" }, [])).toEqual({});
    expect(summarizeForReplay("plain text", ["a"])).toBeNull();
    expect(summarizeForReplay(null, ["a"])).toBeNull();
  });

  it("does not leak fields through prototype or structural mismatches", () => {
    expect(summarizeForReplay({ data: "not-an-object" }, ["data.id"])).toEqual({});
    expect(summarizeForReplay({ list: { notArray: true } }, ["list[].id"])).toEqual({});
    expect(summarizeForReplay({}, ["constructor", "toString"])).toEqual({});
  });

  it("rejects malformed paths loudly", () => {
    expect(() => summarizeForReplay({}, ["a..b"])).toThrow(/Invalid replay field path/);
    expect(() => summarizeForReplay({}, ["a.b-c"])).toThrow(/Invalid replay field path/);
  });

  it("drops an expense's free text but keeps what the UI renders", () => {
    const expense = {
      id: "e1",
      title: "Taxi",
      totalAmount: "12.00",
      currency: "XLM",
      description: "secret",
      voidReason: "free text",
      correctionReason: "free text",
      members: [{ id: "m1", name: "Ana", walletAddress: "G..." }],
      shares: [{ memberId: "m1", name: "Ana", amount: "12.00", paid: false, installments: [{ seq: 1, claimId: "internal" }] }],
    };
    const summary = summarizeForReplay(expense, EXPENSE_REPLAY_FIELDS) as Record<string, any>;
    expect(summary).toMatchObject({ id: "e1", title: "Taxi", totalAmount: "12.00", currency: "XLM" });
    expect(summary.description).toBeUndefined();
    expect(summary.voidReason).toBeUndefined();
    expect(summary.correctionReason).toBeUndefined();
    expect(summary.shares[0].installments[0]).toEqual({ seq: 1 });
  });
});

// ─── 2 & 3. Digest and size cap ───────────────────────────────────────────────

describe("buildStoredReplay", () => {
  it("records a SHA-256 digest and size of the full original body", () => {
    const text = JSON.stringify({ id: "1", secret: "s" });
    const stored = buildStoredReplay(text, JSON.parse(text), ["id"]);
    expect(stored).toEqual({
      body: { id: "1" },
      digest: digestResponseBody(text),
      bytes: Buffer.byteLength(text),
      omitted: false,
    });
    expect(stored.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("omits a summary over the cap but keeps the digest", () => {
    const big = { blob: "x".repeat(IDEMPOTENCY_MAX_REPLAY_BYTES + 1) };
    const text = JSON.stringify(big);
    const stored = buildStoredReplay(text, big, ["blob"]);
    expect(stored.omitted).toBe(true);
    expect(stored.body).toBeNull();
    expect(stored.digest).toBe(digestResponseBody(text));
  });

  it("keeps a large response whose allowlisted summary is small", () => {
    const body = { id: "1", blob: "x".repeat(IDEMPOTENCY_MAX_REPLAY_BYTES * 2) };
    const text = JSON.stringify(body);
    const stored = buildStoredReplay(text, body, ["id"]);
    expect(stored.omitted).toBe(false);
    expect(stored.body).toEqual({ id: "1" });
    expect(stored.bytes).toBeGreaterThan(IDEMPOTENCY_MAX_REPLAY_BYTES * 2);
  });
});

describe("runIdempotentMutation persists only the summary", () => {
  it("stores the allowlisted summary, not the response, in the durable ledger", async () => {
    const rpc = jest.fn(async (fn: string, _args: Record<string, unknown>) =>
      fn === "claim_idempotency_key" ? { data: { outcome: "new_claim" }, error: null } : { data: null, error: null },
    );
    const response = { data: { id: "r1", fileName: "bill.jpg", caption: "Dinner with Ana", storagePath: "receipts/x" } };

    const first = await runIdempotentMutation({
      request: request(),
      client: { rpc } as any,
      key: "summary-key-1",
      replayFields: ["data.id", "data.fileName"],
      principal: WALLET,
      payload: {},
      execute: async () => NextResponse.json(response, { status: 201 }),
    });

    const complete = rpc.mock.calls.find(([fn]) => fn === "complete_idempotency_key")?.[1] as Record<string, unknown>;
    expect(complete.p_response_body).toEqual({ data: { id: "r1", fileName: "bill.jpg" } });
    expect(JSON.stringify(complete)).not.toContain("Dinner with Ana");
    expect(JSON.stringify(complete)).not.toContain("receipts/x");
    expect(complete.p_response_digest).toBe(digestResponseBody(JSON.stringify(response)));
    expect(complete.p_response_bytes).toBe(Buffer.byteLength(JSON.stringify(response)));
    expect(complete.p_replay_omitted).toBe(false);
    expect(complete.p_replay_seconds).toBe(IDEMPOTENCY_REPLAY_TTL_SECONDS);

    // The first caller still gets the full original response.
    expect(await first.json()).toEqual(response);
    expect(first.headers.get(IDEMPOTENCY_DIGEST_HEADER)).toBe(`sha-256=${complete.p_response_digest}`);
  });

  it("replays the summary with the original status and digest", async () => {
    const options = {
      request: request(),
      key: "summary-replay-1",
      replayFields: ["data.id"],
      principal: WALLET,
      payload: {},
      execute: async () => NextResponse.json({ data: { id: "x1", note: "private" } }, { status: 201 }),
    };
    const first = await runIdempotentMutation(options);
    const retry = await runIdempotentMutation(options);
    expect(retry.status).toBe(201);
    expect(await retry.json()).toEqual({ data: { id: "x1" } });
    expect(retry.headers.get(IDEMPOTENCY_DIGEST_HEADER)).toBe(first.headers.get(IDEMPOTENCY_DIGEST_HEADER));
  });

  it("answers a retry of an oversized response with an omitted-body marker, without re-running", async () => {
    const execute = jest.fn(async () =>
      NextResponse.json({ data: { blob: "x".repeat(IDEMPOTENCY_MAX_REPLAY_BYTES + 10) } }, { status: 201 }),
    );
    const options = { request: request(), key: "oversized-1", replayFields: ["data"], principal: WALLET, payload: {}, execute };
    await runIdempotentMutation(options);
    const retry = await runIdempotentMutation(options);

    expect(execute).toHaveBeenCalledTimes(1);
    expect(retry.status).toBe(201);
    expect(retry.headers.get("Idempotent-Replayed")).toBe("true");
    const body = await retry.json();
    expect(body).toEqual({
      idempotentReplay: { completed: true, bodyOmitted: true, reason: expect.any(String), digest: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
    expect(JSON.stringify(body)).not.toContain("xxxx");
  });

  it("stores no part of a non-JSON body beyond its digest", async () => {
    const options = {
      request: request(),
      key: "text-body-1",
      replayFields: ["data"],
      principal: WALLET,
      payload: {},
      execute: async () => new NextResponse("secret text", { status: 200 }),
    };
    await runIdempotentMutation(options);
    const retry = await runIdempotentMutation(options);
    expect(await retry.text()).toBe("null");
  });
});

// ─── 4. Retention window and memory bounds ────────────────────────────────────

describe("replay retention", () => {
  const FP = "fp-1";

  async function complete(key: string, now: number) {
    atomicClaimInMemory(WALLET, key, "/x", FP, 60, now);
    await completeIdempotencyClaim({
      walletAddress: WALLET,
      key,
      fingerprint: FP,
      responseStatus: 201,
      responseBody: { id: "1" },
      responseDigest: "d",
      now,
    });
  }

  it("replays inside the window", async () => {
    const t0 = Date.parse("2026-11-21T00:00:00Z");
    await complete("window-1", t0);
    const claim = atomicClaimInMemory(WALLET, "window-1", "/x", FP, 60, t0 + (IDEMPOTENCY_REPLAY_TTL_SECONDS - 1) * 1000);
    expect(claim).toEqual(expect.objectContaining({ outcome: "completed_replay", responseBody: { id: "1" }, responseDigest: "d" }));
  });

  it("frees the key once the window has passed, even for a different payload", async () => {
    const t0 = Date.parse("2026-11-21T00:00:00Z");
    await complete("window-2", t0);
    const after = t0 + IDEMPOTENCY_REPLAY_TTL_SECONDS * 1000;
    expect(atomicClaimInMemory(WALLET, "window-2", "/x", FP, 60, after).outcome).toBe("new_claim");
    __resetIdempotencyForTests();
    await complete("window-3", t0);
    expect(atomicClaimInMemory(WALLET, "window-3", "/y", "other-fp", 60, after).outcome).toBe("new_claim");
  });

  it("sweeps expired replays and abandoned pending claims", async () => {
    const t0 = Date.parse("2026-11-21T00:00:00Z");
    await complete("sweep-done", t0);
    atomicClaimInMemory(WALLET, "sweep-abandoned", "/x", FP, 60, t0);
    atomicClaimInMemory(WALLET, "sweep-fresh", "/x", FP, 60, t0 + 2 * 24 * 3600 * 1000);

    const removed = sweepIdempotencyMemory(t0 + 2 * 24 * 3600 * 1000);
    expect(removed).toBe(2);
    expect(atomicClaimInMemory(WALLET, "sweep-fresh", "/x", FP, 60, t0 + 2 * 24 * 3600 * 1000).outcome).toBe(
      "temporarily_locked",
    );
  });

  it("bounds the process-local ledger", () => {
    const now = Date.now();
    for (let i = 0; i < IDEMPOTENCY_MAX_MEMORY_RECORDS + 25; i += 1) {
      atomicClaimInMemory(WALLET, `bound-key-${i}`, "/x", FP, 60, now);
    }
    sweepIdempotencyMemory(now);
    // The oldest were evicted; the newest is still held.
    expect(atomicClaimInMemory(WALLET, "bound-key-0", "/x", FP, 60, now).outcome).toBe("new_claim");
    expect(
      atomicClaimInMemory(WALLET, `bound-key-${IDEMPOTENCY_MAX_MEMORY_RECORDS + 24}`, "/x", FP, 60, now).outcome,
    ).toBe("temporarily_locked");
  });
});

// ─── 5. Cleanup path ──────────────────────────────────────────────────────────

describe("idempotency cleanup", () => {
  it("calls the batched purge with the documented retention", async () => {
    const rpc = jest.fn(async (_fn: string, _args: Record<string, unknown>) => ({
      data: { redacted: 3, deleted: 2, stale_pending_deleted: 1, batch_size: 1000 },
      error: null,
    }));
    const result = await purgeIdempotencyRecords({ rpc } as any, { now: Date.parse("2026-11-21T00:00:00Z") });
    expect(rpc).toHaveBeenCalledWith("purge_idempotency_records", {
      p_now: "2026-11-21T00:00:00.000Z",
      p_batch_size: 1000,
      p_audit_retention_days: IDEMPOTENCY_AUDIT_RETENTION_DAYS,
      p_stale_pending_hours: 24,
    });
    expect(result).toEqual(expect.objectContaining({ redacted: 3, deleted: 2, stalePendingDeleted: 1 }));
  });

  it("reports a failed purge without leaking the database error", async () => {
    const rpc = jest.fn(async () => ({ data: null, error: { message: "permission denied for table secrets" } }));
    await expect(purgeIdempotencyRecords({ rpc } as any)).rejects.toThrow("The idempotency retention sweep failed.");
  });

  it("refuses the cron route without CRON_SECRET", async () => {
    const previous = process.env.CRON_SECRET;
    process.env.CRON_SECRET = "cron-secret-value";
    try {
      const anonymous = await cleanupRoute(new NextRequest("http://x/api/idempotency/cleanup"));
      expect(anonymous.status).toBe(401);
      const wrong = await cleanupRoute(
        new NextRequest("http://x/api/idempotency/cleanup", { headers: { Authorization: "Bearer nope" } }),
      );
      expect(wrong.status).toBe(401);
      const ok = await cleanupRoute(
        new NextRequest("http://x/api/idempotency/cleanup", { headers: { Authorization: "Bearer cron-secret-value" } }),
      );
      expect(ok.status).toBe(200);
      expect((await ok.json()).data).toEqual(expect.objectContaining({ memoryRemoved: expect.any(Number) }));
    } finally {
      process.env.CRON_SECRET = previous;
    }
  });

  it("is scheduled daily", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
    expect(vercel.crons).toEqual(expect.arrayContaining([expect.objectContaining({ path: "/api/idempotency/cleanup" })]));
  });
});

// ─── Migration ────────────────────────────────────────────────────────────────

describe("migration 0024_idempotency_retention.sql", () => {
  const sql = fs.readFileSync(path.join(ROOT, "migrations", "0024_idempotency_retention.sql"), "utf8");
  const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

  it("adds the audit columns and the size cap", () => {
    for (const column of ["response_digest", "response_bytes", "replay_omitted", "completed_at", "replay_expires_at", "redacted_at"]) {
      expect(sql).toContain(`ADD COLUMN IF NOT EXISTS ${column}`);
    }
    expect(sql).toContain("octet_length(response_body::text) <= 16384");
  });

  it("redacts bodies stored before the allowlist existed", () => {
    expect(sql).toMatch(/UPDATE public\.idempotency_records\s+SET response_body\s+= NULL/);
  });

  it("indexes every cleanup path", () => {
    expect(sql).toContain("idx_idempotency_records_replay_expiry");
    expect(sql).toContain("idx_idempotency_records_completed_at");
    expect(sql).toContain("idx_idempotency_records_stale_pending");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
  });

  it("replays only within the window and keeps locked_until non-null on completion", () => {
    expect(sql).toContain("replay_expires_at");
    expect(sql).not.toMatch(/locked_until\s*=\s*NULL/);
  });

  it("removes anonymous access and scopes callers to their own wallet", () => {
    expect(sql).toMatch(/REVOKE EXECUTE ON FUNCTION public\.claim_idempotency_key[^;]+FROM PUBLIC, anon;/);
    expect(sql).not.toMatch(/GRANT EXECUTE[^;]+TO[^;]*\banon\b/);
    expect(sql).toContain("assert_idempotency_principal");
  });

  it("is mirrored into supabase-setup.sql and registered", () => {
    expect(setup).toContain("Cumulative Addition from 0024_idempotency_retention.sql (#414)");
    expect(setup).toContain("FUNCTION public.purge_idempotency_records(");
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "migrations", "manifest.json"), "utf8"));
    expect(manifest.migrations.map((m: { id: string }) => m.id)).toContain("0024_idempotency_retention");
  });
});

// ─── 6. Every required route declares its allowlist ───────────────────────────

describe("required routes declare replay allowlists", () => {
  it("passes replayFields to every runIdempotentMutation call", () => {
    const missing: string[] = [];
    for (const route of Object.keys(IDEMPOTENCY_REQUIRED_ROUTES)) {
      const source = fs.readFileSync(path.join(ROOT, "app", ...route.split("/").filter(Boolean), "route.ts"), "utf8");
      const calls = source.split("runIdempotentMutation({").slice(1);
      calls.forEach((call, index) => {
        const options = call.slice(0, call.indexOf("execute:"));
        if (!options.includes("replayFields:")) missing.push(`${route} (call ${index + 1})`);
      });
    }
    expect(missing).toEqual([]);
  });

  it("keeps one-time secrets out of the durable ledger", () => {
    for (const route of ["/api/v1/tokens", "/api/v1/webhooks", "/api/invitations/create", "/api/account/delete"]) {
      const source = fs.readFileSync(path.join(ROOT, "app", ...route.split("/").filter(Boolean), "route.ts"), "utf8");
      expect({ route, persist: source.includes("persist: false") }).toEqual({ route, persist: true });
    }
  });
});
