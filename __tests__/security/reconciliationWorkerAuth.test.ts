/**
 * __tests__/security/reconciliationWorkerAuth.test.ts
 *
 * Issue #415: Secure and schedule reconciliation work.
 *
 * Verifies:
 *  1. Anonymous, wrong-secret and ordinary wallet callers cannot run the
 *     worker. There is no development or test fallback.
 *  2. The cron secret (constant time) and explicit staff credentials can.
 *  3. The scheduled entry point accepts only the cron secret.
 *  4. The report is not public: a wallet sees only its own rows.
 *  5. Runs are bounded (batch size, batch count, time budget) and every run
 *     records actor, request ID, duration and result, without error text.
 *  6. The schedule lives in vercel.json, and the run log migration is
 *     service-role only.
 */

import fs from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import { runReconciliationWorker, getReconciliationReport } from "@/lib/settlement/reconciliationWorker";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { GET as reportRoute, POST as runRoute } from "@/app/api/settlement/reconciliation-worker/route";
import { GET as cronRoute } from "@/app/api/settlement/reconciliation-worker/cron/route";
import { POST as developerRunRoute } from "@/app/api/developer/reconciliation/route";
import {
  RECONCILIATION_DEFAULT_BATCH_SIZE,
  RECONCILIATION_MAX_BATCHES,
  RECONCILIATION_MAX_BATCH_SIZE,
  __resetReconciliationRunsForTests,
  executeReconciliationRun,
} from "@/lib/settlement/reconciliationRun";

jest.mock("@/lib/settlement/reconciliationWorker", () => ({
  runReconciliationWorker: jest.fn(),
  getReconciliationReport: jest.fn(),
}));

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => false,
  createServiceRoleClient: jest.fn(),
  createServerClientForToken: jest.fn(() => ({ kind: "user" })),
}));

const worker = jest.mocked(runReconciliationWorker);
const report = jest.mocked(getReconciliationReport);
const serviceClient = jest.mocked(createServiceRoleClient);

const CRON_SECRET = "cron-secret-0123456789abcdef";
const STAFF_SECRET = "staff-secret-0123456789abcdef";
const STAFF_WALLET = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const USER_WALLET = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
const REQUEST_ID = "11111111-2222-4333-8444-555555555555";

const ENV_KEYS = [
  "CRON_SECRET",
  "SUPPORT_STAFF_SECRET",
  "SPONSOR_OPERATOR_SECRET",
  "OPERATOR_SECRET",
  "RECONCILIATION_STAFF_WALLETS",
  "SUPPORT_STAFF_WALLETS",
] as const;
const savedEnv: Record<string, string | undefined> = {};

let insert: jest.Mock;

function emptyBatch(processed = 0) {
  return { processed, recorded: processed, escalated: 0, pending: 0, failed: 0, durationMs: 1, errors: [] };
}

function req(url: string, { method = "POST", headers = {}, body }: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "x-request-id": REQUEST_ID, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const RUN = "/api/settlement/reconciliation-worker";

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.CRON_SECRET = CRON_SECRET;
  process.env.SUPPORT_STAFF_SECRET = STAFF_SECRET;
  process.env.RECONCILIATION_STAFF_WALLETS = STAFF_WALLET;

  __resetReconciliationRunsForTests();
  worker.mockReset();
  worker.mockResolvedValue(emptyBatch(0));
  report.mockReset();
  report.mockResolvedValue({ jobs: [], summary: {} } as any);
  insert = jest.fn(async () => ({ error: null }));
  serviceClient.mockReset();
  serviceClient.mockReturnValue({ kind: "service", from: jest.fn(() => ({ insert })) } as any);
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  jest.restoreAllMocks();
});

// ─── 1. Refused callers ───────────────────────────────────────────────────────

describe("callers that cannot run reconciliation", () => {
  it("refuses an anonymous request and runs nothing", async () => {
    const res = await runRoute(req(RUN));
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe("RECONCILIATION_AUTH_REQUIRED");
    expect(worker).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses anonymous requests even with no secrets configured (no dev/test fallback)", async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    expect((await runRoute(req(RUN))).status).toBe(401);
    expect((await runRoute(req(RUN, { headers: { "x-staff-id": "dev-support-staff" } }))).status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it.each([
    ["a wrong cron secret", { Authorization: "Bearer not-the-secret" }],
    ["a prefix of the cron secret", { Authorization: `Bearer ${CRON_SECRET.slice(0, -1)}` }],
    ["the cron secret plus extra", { Authorization: `Bearer ${CRON_SECRET}x` }],
    ["the cron secret without Bearer", { Authorization: CRON_SECRET }],
    ["a wrong staff secret", { "x-staff-secret": "nope" }],
    ["the staff secret in the wrong header", { "x-operator-secret": STAFF_SECRET }],
  ])("refuses %s", async (_label, headers) => {
    const res = await runRoute(req(RUN, { headers }));
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("refuses an ordinary wallet session with 403", async () => {
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${signWalletSession(USER_WALLET)}` } }));
    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("RECONCILIATION_STAFF_REQUIRED");
    expect(worker).not.toHaveBeenCalled();
  });

  it("does not treat every wallet as staff when the allowlist is empty", async () => {
    delete process.env.RECONCILIATION_STAFF_WALLETS;
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${signWalletSession(STAFF_WALLET)}` } }));
    expect(res.status).toBe(403);
  });

  it("protects the developer re-export the same way", async () => {
    expect((await developerRunRoute(req("/api/developer/reconciliation"))).status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });
});

// ─── 2. Accepted callers ──────────────────────────────────────────────────────

describe("callers that can run reconciliation", () => {
  it("accepts the cron secret and records the run", async () => {
    worker.mockResolvedValueOnce(emptyBatch(3));
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run).toEqual(
      expect.objectContaining({ actorKind: "cron", actorId: "cron", trigger: "schedule", requestId: REQUEST_ID, outcome: "succeeded", processed: 3 }),
    );
    expect(res.headers.get("x-request-id")).toBe(REQUEST_ID);
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        request_id: REQUEST_ID,
        actor_kind: "cron",
        actor_id: "cron",
        trigger: "schedule",
        outcome: "succeeded",
        processed: 3,
        duration_ms: expect.any(Number),
      }),
    );
  });

  it("accepts the staff secret as a manual run", async () => {
    const res = await runRoute(req(RUN, { headers: { "x-staff-secret": STAFF_SECRET } }));
    expect(res.status).toBe(200);
    expect((await res.json()).run).toEqual(expect.objectContaining({ actorKind: "staff", actorId: "staff-secret", trigger: "manual" }));
  });

  it("accepts the operator secret", async () => {
    process.env.SPONSOR_OPERATOR_SECRET = "operator-secret-0123456789";
    const res = await runRoute(req(RUN, { headers: { "x-operator-secret": "operator-secret-0123456789" } }));
    expect(res.status).toBe(200);
    expect((await res.json()).run.actorId).toBe("operator-secret");
  });

  it("accepts a wallet on the explicit staff allowlist and records which wallet", async () => {
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${signWalletSession(STAFF_WALLET)}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).run).toEqual(expect.objectContaining({ actorKind: "staff", actorId: `wallet:${STAFF_WALLET}` }));
  });

  it("answers 503, without running, when the service role is not configured", async () => {
    serviceClient.mockReturnValue(null);
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(503);
    expect(worker).not.toHaveBeenCalled();
  });
});

// ─── 3. Scheduled entry point ─────────────────────────────────────────────────

describe("GET /api/settlement/reconciliation-worker/cron", () => {
  const CRON = "/api/settlement/reconciliation-worker/cron";

  it("runs a scheduled pass for the cron secret", async () => {
    const res = await cronRoute(req(CRON, { method: "GET", headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(200);
    expect((await res.json()).run).toEqual(expect.objectContaining({ trigger: "schedule", actorKind: "cron" }));
    expect(worker).toHaveBeenCalledWith({ batchSize: RECONCILIATION_DEFAULT_BATCH_SIZE, walletAddress: undefined }, expect.anything());
  });

  it.each([
    ["anonymous", {}],
    ["staff secret", { "x-staff-secret": STAFF_SECRET }],
    ["staff wallet", { Authorization: `Bearer ${signWalletSession(STAFF_WALLET)}` }],
  ])("accepts only the cron secret, not %s", async (_label, headers) => {
    const res = await cronRoute(req(CRON, { method: "GET", headers }));
    expect(res.status).toBe(401);
    expect(worker).not.toHaveBeenCalled();
  });

  it("is disabled when CRON_SECRET is unset", async () => {
    delete process.env.CRON_SECRET;
    const res = await cronRoute(req(CRON, { method: "GET", headers: { Authorization: "Bearer " } }));
    expect(res.status).toBe(401);
  });
});

// ─── 4. Report access ─────────────────────────────────────────────────────────

describe("GET /api/settlement/reconciliation-worker", () => {
  it("refuses anonymous readers instead of using the service role", async () => {
    const res = await reportRoute(req(`${RUN}?wallet=${STAFF_WALLET}`, { method: "GET" }));
    expect(res.status).toBe(401);
    expect(report).not.toHaveBeenCalled();
    expect(serviceClient).not.toHaveBeenCalled();
  });

  it("pins a wallet's report to its own wallet and RLS client", async () => {
    const res = await reportRoute(
      req(`${RUN}?wallet=${STAFF_WALLET}`, { method: "GET", headers: { Authorization: `Bearer ${signWalletSession(USER_WALLET)}` } }),
    );
    expect(res.status).toBe(200);
    const [filter, client] = report.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(filter.wallet).toBe(USER_WALLET);
    expect(client).toEqual({ kind: "user" });
    expect((await res.json()).recentRuns).toBeUndefined();
  });

  it("gives staff the full report and recent runs", async () => {
    await runRoute(req(RUN, { headers: { "x-staff-secret": STAFF_SECRET } }));
    const res = await reportRoute(req(`${RUN}?limit=100000`, { method: "GET", headers: { "x-staff-secret": STAFF_SECRET } }));
    expect(res.status).toBe(200);
    const [filter] = report.mock.calls[0] as [Record<string, unknown>];
    expect(filter.wallet).toBeUndefined();
    expect(filter.limit).toBe(200);
    const body = await res.json();
    expect(body.recentRuns).toHaveLength(1);
  });

  it("does not leak internal error text from a failed report", async () => {
    report.mockRejectedValueOnce(new Error("relation reconciliation_queue does not exist"));
    const res = await reportRoute(req(RUN, { method: "GET", headers: { "x-staff-secret": STAFF_SECRET } }));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("relation");
  });
});

// ─── 5. Bounds and records ────────────────────────────────────────────────────

describe("bounded, recorded runs", () => {
  it.each([
    [10_000, RECONCILIATION_MAX_BATCH_SIZE],
    [0, 1],
    [-5, 1],
    [7.9, 7],
    ["abc", RECONCILIATION_DEFAULT_BATCH_SIZE],
  ])("clamps a requested batch size of %p to %p", async (requested, expected) => {
    await runRoute(req(RUN, { headers: { "x-staff-secret": STAFF_SECRET }, body: { batchSize: requested } }));
    expect(worker).toHaveBeenCalledWith(expect.objectContaining({ batchSize: expected }), expect.anything());
  });

  it("stops after the maximum number of batches when the queue never drains", async () => {
    worker.mockImplementation(async (options) => emptyBatch(options?.batchSize ?? 0));
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(worker).toHaveBeenCalledTimes(RECONCILIATION_MAX_BATCHES);
    expect((await res.json()).run.batches).toBe(RECONCILIATION_MAX_BATCHES);
  });

  it("stops as soon as a batch comes back short", async () => {
    worker.mockResolvedValueOnce(emptyBatch(RECONCILIATION_DEFAULT_BATCH_SIZE)).mockResolvedValueOnce(emptyBatch(2));
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(worker).toHaveBeenCalledTimes(2);
    expect((await res.json()).run).toEqual(expect.objectContaining({ batches: 2, processed: RECONCILIATION_DEFAULT_BATCH_SIZE + 2 }));
  });

  it("stops when the time budget is spent", async () => {
    let now = 0;
    const fake = jest.fn(async ({ batchSize }: { batchSize?: number }) => {
      now += 30_000;
      return emptyBatch(batchSize ?? 0);
    });
    const { record } = await executeReconciliationRun({
      actor: { kind: "cron", id: "cron" },
      requestId: REQUEST_ID,
      trigger: "schedule",
      client: { from: () => ({ insert }) } as any,
      worker: fake as any,
      clock: () => now,
      timeBudgetMs: 45_000,
    });
    expect(fake).toHaveBeenCalledTimes(2);
    expect(record.durationMs).toBe(60_000);
  });

  it("records a failed run with a stable code and no internal error text", async () => {
    worker.mockRejectedValueOnce(new Error("connection to db-internal.prod:5432 refused"));
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.run).toEqual(expect.objectContaining({ outcome: "failed", failureCode: "RECONCILIATION_RUN_FAILED" }));
    expect(JSON.stringify(body)).not.toContain("db-internal");
    const stored = insert.mock.calls[0][0];
    expect(stored).toEqual(expect.objectContaining({ outcome: "failed", failure_code: "RECONCILIATION_RUN_FAILED" }));
    expect(JSON.stringify(stored)).not.toContain("db-internal");
  });

  it("stores only the IDs of jobs that errored, never their messages", async () => {
    worker.mockResolvedValueOnce({
      ...emptyBatch(1),
      errors: [{ jobId: "job-1", error: "Horizon 500 at https://internal-proxy/tx" }],
    });
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    const stored = insert.mock.calls[0][0];
    expect(stored).toEqual(expect.objectContaining({ error_count: 1, errored_job_ids: ["job-1"] }));
    expect(JSON.stringify(stored)).not.toContain("internal-proxy");
    // The trusted caller still gets per-job detail in the response.
    expect((await res.json()).result.errors).toHaveLength(1);
  });

  it("still answers when the run log cannot be written", async () => {
    insert.mockResolvedValueOnce({ error: { message: "permission denied" } });
    const res = await runRoute(req(RUN, { headers: { Authorization: `Bearer ${CRON_SECRET}` } }));
    expect(res.status).toBe(200);
  });
});

// ─── 6. Deployment configuration ──────────────────────────────────────────────

describe("schedule and storage", () => {
  const ROOT = process.cwd();

  it("schedules the cron entry point in vercel.json", () => {
    const vercel = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
    expect(vercel.crons).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "/api/settlement/reconciliation-worker/cron" })]),
    );
  });

  it("exposes the cron entry point as GET only", () => {
    const source = fs.readFileSync(path.join(ROOT, "app/api/settlement/reconciliation-worker/cron/route.ts"), "utf8");
    expect(source).toMatch(/export async function GET/);
    expect(source).not.toMatch(/export (async function|const) (POST|PUT|PATCH|DELETE)/);
  });

  it("keeps the run log service-role only", () => {
    const sql = fs.readFileSync(path.join(ROOT, "migrations/0025_reconciliation_worker_runs.sql"), "utf8");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.reconciliation_worker_runs");
    expect(sql).toContain("ENABLE ROW LEVEL SECURITY");
    expect(sql).toMatch(/REVOKE ALL ON public\.reconciliation_worker_runs FROM PUBLIC, anon, authenticated;/);
    expect(sql).not.toMatch(/GRANT[^;]+TO[^;]*\b(anon|authenticated)\b/);
    for (const column of ["request_id", "actor_kind", "actor_id", "duration_ms", "outcome", "batch_size"]) {
      expect(sql).toContain(column);
    }
  });
});
