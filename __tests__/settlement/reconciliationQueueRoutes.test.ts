/**
 * __tests__/settlement/reconciliationQueueRoutes.test.ts
 *
 * Issue #416, HTTP side: requests enqueue durable work instead of doing
 * Horizon work, or dropping it, inside the request.
 *
 *  - POST /api/settlement/reconciliation-worker { action: "enqueue" } queues
 *    pending intents and answers 202 without any Horizon call.
 *  - { action: "requeue" } returns a dead-lettered job to the queue (staff only).
 *  - POST /api/settlement/reconcile queues the payment (202) instead of
 *    abandoning it when Horizon is unavailable, and a retry gets the same job.
 */

import { NextRequest } from "next/server";
import { signWalletSession } from "@/lib/supabase/serverAuth";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { POST as workerRoute } from "@/app/api/settlement/reconciliation-worker/route";
import { POST as reconcileRoute } from "@/app/api/settlement/reconcile/route";
import { HorizonVerificationError, verifyPaymentByHash } from "@/lib/settlement/horizonVerify";

const STAFF_SECRET = "staff-secret-0123456789abcdef";
const PAYER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const MEMBER = "GBXGQJWVLWOYHFLVTKWV5FGHA3LNYY2JQKM7OAJAUEQFU6LPCSEFVXON";
const JOB_ID = "6f1c2b9e-1d4a-4c1e-9a77-3b2f0e5d8c41";

type Rpc = jest.Mock<Promise<{ data: unknown; error: unknown }>, [string, Record<string, unknown>]>;
let serviceRpc: Rpc;
let userRpc: Rpc;
const queued = new Map<string, Record<string, unknown>>();

function fakeClient(rpc: Rpc) {
  const intents = [
    { id: "11111111-1111-4111-8111-111111111111", trip_id: "t", expense_id: "e1", member_id: "m", payer_wallet: PAYER, member_wallet: MEMBER, currency: "XLM", amount: "5", request_id: "r1", tx_hash: null },
    { id: "22222222-2222-4222-8222-222222222222", trip_id: "t", expense_id: "e2", member_id: "m", payer_wallet: PAYER, member_wallet: MEMBER, currency: "XLM", amount: "7", request_id: "r2", tx_hash: null },
  ];
  const chain = (data: unknown) => {
    const builder: any = {
      select: () => builder,
      in: () => builder,
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data, error: null }),
    };
    return builder;
  };
  return {
    rpc,
    from: (table: string) => (table === "settlement_intents" ? chain(intents) : chain([])),
  };
}

function enqueueImpl(): Rpc {
  return jest.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === "enqueue_reconciliation_job") {
      const key = String(args.p_dedupe_key);
      if (!queued.has(key)) {
        queued.set(key, {
          id: `job-${queued.size + 1}`,
          dedupe_key: key,
          intent_id: args.p_intent_id,
          trip_id: args.p_trip_id,
          expense_id: args.p_expense_id,
          member_id: args.p_member_id,
          payer_wallet: args.p_payer_wallet,
          member_wallet: args.p_member_wallet,
          asset: args.p_asset,
          amount: args.p_amount,
          amount_stroops: args.p_amount_stroops,
          tx_hash: args.p_tx_hash,
          status: args.p_tx_hash ? "submitted_not_confirmed" : "not_submitted",
          attempts: 0,
          max_attempts: 10,
          backoff_ms: 5000,
          next_attempt_at: new Date().toISOString(),
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      return { data: [queued.get(key)], error: null };
    }
    if (name === "requeue_reconciliation_job") return { data: args.p_id === JOB_ID, error: null };
    return { data: null, error: { message: `unexpected rpc ${name}` } };
  });
}

jest.mock("@/lib/supabase/server", () => ({
  isServerSupabaseConfigured: () => true,
  createServiceRoleClient: jest.fn(),
  createServerClientForToken: jest.fn(() => fakeClient(userRpc)),
}));

jest.mock("@/lib/settlement/horizonVerify", () => {
  const actual = jest.requireActual("@/lib/settlement/horizonVerify");
  return { ...actual, verifyPaymentByHash: jest.fn() };
});

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  fetchSettlementIntentByIdempotencyKey: jest.fn().mockResolvedValue(null),
  fetchSettlementIntentByPayment: jest.fn().mockResolvedValue(null),
}));

const serviceClient = jest.mocked(createServiceRoleClient);
const verify = jest.mocked(verifyPaymentByHash);

function post(url: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  queued.clear();
  process.env.SUPPORT_STAFF_SECRET = STAFF_SECRET;
  serviceRpc = enqueueImpl();
  userRpc = enqueueImpl();
  serviceClient.mockReturnValue(fakeClient(serviceRpc) as any);
  verify.mockReset();
  global.fetch = jest.fn(() => {
    throw new Error("unexpected network call");
  }) as never;
  jest.spyOn(console, "info").mockImplementation(() => {});
  jest.spyOn(console, "warn").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  delete process.env.SUPPORT_STAFF_SECRET;
  jest.restoreAllMocks();
});

describe("POST /api/settlement/reconciliation-worker actions", () => {
  const staff = { "x-staff-secret": STAFF_SECRET };

  it("enqueue: queues pending intents, answers 202, and calls no network", async () => {
    const res = await workerRoute(post("/api/settlement/reconciliation-worker", { action: "enqueue" }, staff));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual(expect.objectContaining({ ok: true, action: "enqueue", enqueued: 2 }));
    expect(global.fetch).not.toHaveBeenCalled();
    expect([...queued.keys()].sort()).toEqual([
      "intent:11111111-1111-4111-8111-111111111111",
      "intent:22222222-2222-4222-8222-222222222222",
    ]);
  });

  it("requeue: returns a dead-lettered job to the queue, or 409 when it is not dead-lettered", async () => {
    const ok = await workerRoute(post("/api/settlement/reconciliation-worker", { action: "requeue", jobId: JOB_ID }, staff));
    expect(ok.status).toBe(202);
    expect(serviceRpc).toHaveBeenCalledWith("requeue_reconciliation_job", { p_id: JOB_ID });

    const missing = await workerRoute(
      post("/api/settlement/reconciliation-worker", { action: "requeue", jobId: "7f1c2b9e-1d4a-4c1e-9a77-3b2f0e5d8c41" }, staff),
    );
    expect(missing.status).toBe(409);
  });

  it("rejects an unknown action or a malformed job id with 400", async () => {
    expect((await workerRoute(post("/api/settlement/reconciliation-worker", { action: "drop-table" }, staff))).status).toBe(400);
    expect((await workerRoute(post("/api/settlement/reconciliation-worker", { action: "requeue", jobId: "1; drop" }, staff))).status).toBe(400);
  });

  it("refuses enqueue and requeue without staff credentials", async () => {
    expect((await workerRoute(post("/api/settlement/reconciliation-worker", { action: "enqueue" }))).status).toBe(401);
    const wallet = { authorization: `Bearer ${signWalletSession(MEMBER)}` };
    expect((await workerRoute(post("/api/settlement/reconciliation-worker", { action: "requeue", jobId: JOB_ID }, wallet))).status).toBe(403);
    expect(serviceRpc).not.toHaveBeenCalled();
  });
});

describe("POST /api/settlement/reconcile during a Horizon outage", () => {
  const body = {
    txHash: "c".repeat(64),
    expenseId: "e1",
    memberId: "m",
    tripId: "t",
    amount: "5.0000000",
    payerWallet: PAYER,
    memberWallet: MEMBER,
  };

  it("queues the payment for a participant and answers 202; a retry gets the same job", async () => {
    verify.mockRejectedValue(new HorizonVerificationError("Could not reach Horizon: timeout", true));
    const auth = { authorization: `Bearer ${signWalletSession(MEMBER)}` };

    const first = await reconcileRoute(post("/api/settlement/reconcile", body, auth));
    expect(first.status).toBe(202);
    const firstBody = await first.json();
    expect(firstBody).toEqual(expect.objectContaining({ ok: true, queued: true, reconciled: false, jobStatus: "submitted_not_confirmed" }));

    const retry = await reconcileRoute(post("/api/settlement/reconcile", body, auth));
    expect(retry.status).toBe(202);
    expect((await retry.json()).jobId).toBe(firstBody.jobId);
    expect(queued.size).toBe(1);
    // Enqueued with the caller's RLS client, never the service role.
    expect(userRpc).toHaveBeenCalledWith("enqueue_reconciliation_job", expect.objectContaining({ p_tx_hash: "c".repeat(64) }));
    expect(serviceRpc).not.toHaveBeenCalled();
  });

  it("still answers 503 for an anonymous caller, who has no principal to queue under", async () => {
    verify.mockRejectedValue(new HorizonVerificationError("Horizon returned HTTP 502.", true));
    const res = await reconcileRoute(post("/api/settlement/reconcile", body));
    expect(res.status).toBe(503);
    expect(queued.size).toBe(0);
  });

  it("does not queue for a session that is not a party to the payment", async () => {
    verify.mockRejectedValue(new HorizonVerificationError("Horizon returned HTTP 502.", true));
    const outsider = { authorization: `Bearer ${signWalletSession("GCAX6Y4Z2ABCDEFGHIJKLMNOPQRSTUVWXYZ234567ABCDEFGHIJKLMNO")}` };
    const res = await reconcileRoute(post("/api/settlement/reconcile", body, outsider));
    expect(res.status).toBe(503);
    expect(queued.size).toBe(0);
  });

  it("still answers 422 for a payment Horizon proves invalid", async () => {
    verify.mockRejectedValue(new HorizonVerificationError("Transaction failed on the ledger."));
    const auth = { authorization: `Bearer ${signWalletSession(MEMBER)}` };
    const res = await reconcileRoute(post("/api/settlement/reconcile", body, auth));
    expect(res.status).toBe(422);
    expect(queued.size).toBe(0);
  });
});
