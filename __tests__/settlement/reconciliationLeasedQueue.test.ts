/**
 * __tests__/settlement/reconciliationLeasedQueue.test.ts
 *
 * Issue #416: move reconciliation to a leased queue.
 *
 *  1. Concurrency: two (or more) workers draining the same queue never
 *     reconcile the same job. Every side effect happens once per job.
 *  2. Leases: a dead worker's job is recovered once its lease expires, and the
 *     dead worker's late writes are discarded (fenced on the lease token).
 *  3. Heartbeats keep a long-running job's lease alive.
 *  4. Failures back off and then dead-letter, and staff can requeue them.
 *     Poison jobs whose lease keeps expiring are dead-lettered too.
 *  5. Deadlines: claims a run cannot start are handed back unconsumed.
 *  6. Load: a 1,000-job backlog drains with 4 workers, exactly once per job.
 *  7. HTTP: `enqueue` makes no Horizon call, and the SQL keeps its guarantees
 *     (SKIP LOCKED, fencing, grants, both provisioning paths, plan fixture).
 */

import fs from "fs";
import path from "path";
import {
  runReconciliationWorker,
  updateReconciliationJobRow,
  WorkerRateLimiter,
} from "@/lib/settlement/reconciliationWorker";
import {
  ReconciliationLease,
  ReconciliationLeaseLostError,
  claimReconciliationJobs,
  reconciliationDedupeKey,
  reconciliationFailureCode,
  requeueReconciliationJob,
} from "@/lib/settlement/reconciliationQueue";
import { markSharePaidRow } from "@/lib/supabase/queries";
import { checkIsPaid } from "@/lib/stellar/contract";
import { FakeReconciliationQueue } from "./fakeReconciliationQueue";

jest.mock("@/lib/utils/constants", () => ({
  ...jest.requireActual("@/lib/utils/constants"),
  HORIZON_URL: "https://horizon-testnet.stellar.org",
  CONTRACT_ID: "contract-test-id",
}));

jest.mock("@/lib/supabase/queries", () => ({
  ...jest.requireActual("@/lib/supabase/queries"),
  markSharePaidRow: jest.fn(),
}));

jest.mock("@/lib/settlement/intent", () => ({
  markIntentRecorded: jest.fn().mockResolvedValue(undefined),
  markIntentFailed: jest.fn().mockResolvedValue(undefined),
}));

jest.mock("@/lib/stellar/contract", () => ({
  checkIsPaid: jest.fn(),
  recordPaymentOnChain: jest.fn().mockResolvedValue({ success: true, ledger: 100 }),
}));

jest.mock("@/lib/settlement/settleOnChain", () => ({
  fetchAttestation: jest.fn().mockResolvedValue({ ok: false }),
}));

jest.mock("@/lib/observability/reportError", () => ({ reportError: jest.fn() }));

const markShare = jest.mocked(markSharePaidRow);
const isPaid = jest.mocked(checkIsPaid);
const noLimit = new WorkerRateLimiter(0);

/** Side effects per job: the thing that must happen exactly once. */
let sideEffects: Map<string, number>;

function tick(ms = 0) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  jest.clearAllMocks();
  sideEffects = new Map();
  markShare.mockImplementation(async (expenseId: string) => {
    // Yield so concurrent workers interleave around the side effect.
    await tick();
    sideEffects.set(expenseId, (sideEffects.get(expenseId) ?? 0) + 1);
    return {} as never;
  });
  isPaid.mockResolvedValue({ paid: true } as never);
  global.fetch = jest.fn(() => {
    throw new Error("No Horizon call is expected in these tests");
  }) as never;
});

async function drain(db: FakeReconciliationQueue, workers: number, batchSize: number) {
  const client = db.client();
  const perWorker = await Promise.all(
    Array.from({ length: workers }, async (_, n) => {
      const totals = { claimed: 0, recorded: 0, leaseLost: 0, batches: 0 };
      for (;;) {
        const result = await runReconciliationWorker(
          { batchSize, workerId: `worker-${n}`, syncIntents: false },
          client,
          noLimit,
        );
        totals.batches += 1;
        totals.claimed += result.claimed ?? 0;
        totals.recorded += result.recorded;
        totals.leaseLost += result.leaseLost ?? 0;
        if ((result.claimed ?? 0) === 0) break;
      }
      return totals;
    }),
  );
  return perWorker;
}

// ─── 1. Concurrency ───────────────────────────────────────────────────────────

describe("concurrent workers", () => {
  it("two workers draining one queue never reconcile the same job", async () => {
    const db = new FakeReconciliationQueue();
    const jobs = db.seed(40);

    const [a, b] = await drain(db, 2, 10);

    expect(a.claimed + b.claimed).toBe(40);
    expect(a.claimed).toBeGreaterThan(0);
    expect(b.claimed).toBeGreaterThan(0);
    // No job was ever leased to two workers.
    const owners = new Map<string, Set<string>>();
    for (const c of db.claims) owners.set(c.jobId, (owners.get(c.jobId) ?? new Set()).add(c.workerId));
    expect([...owners.values()].every((set) => set.size === 1)).toBe(true);
    // Every job recorded, every side effect exactly once.
    expect([...db.rows.values()].every((row) => row.status === "recorded" && row.lease_token === null)).toBe(true);
    for (const job of jobs) expect(sideEffects.get(job.expense_id)).toBe(1);
  });

  it("a second claim while the first lease is live gets nothing", async () => {
    const db = new FakeReconciliationQueue();
    db.seed(3);
    const client = db.client();
    const first = await claimReconciliationJobs(client, { workerId: "A", batchSize: 10 });
    const second = await claimReconciliationJobs(client, { workerId: "B", batchSize: 10 });
    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
  });
});

// ─── 2. Lease recovery and fencing ────────────────────────────────────────────

describe("lease recovery", () => {
  it("recovers a dead worker's job after the lease expires and discards the dead worker's late write", async () => {
    const db = new FakeReconciliationQueue();
    const [job] = db.seed(1);
    const client = db.client();

    // Worker A claims, then dies without finishing.
    const [claimA] = await claimReconciliationJobs(client, { workerId: "A", batchSize: 1, leaseSeconds: 30 });
    expect(claimA.row.id).toBe(job.id);

    // Before expiry nobody else can have it.
    expect((await runReconciliationWorker({ workerId: "B", syncIntents: false }, client, noLimit)).claimed).toBe(0);

    db.offsetMs += 31_000;
    const resultB = await runReconciliationWorker({ workerId: "B", syncIntents: false }, client, noLimit);
    expect(resultB).toEqual(expect.objectContaining({ claimed: 1, recorded: 1 }));
    expect(db.claims[db.claims.length - 1]).toEqual(expect.objectContaining({ workerId: "B", recovery: true }));
    expect(db.rows.get(job.id)?.lease_recoveries).toBe(1);

    // A wakes up and tries to write with its stale token: rejected, nothing changes.
    const staleLease = new ReconciliationLease(client, job.id, claimA.leaseToken);
    await expect(
      updateReconciliationJobRow(job.id, { status: "failed" }, client, staleLease),
    ).rejects.toBeInstanceOf(ReconciliationLeaseLostError);
    expect(staleLease.lost).toBe(true);
    expect(db.rows.get(job.id)?.status).toBe("recorded");
    await expect(staleLease.assertHeld()).rejects.toBeInstanceOf(ReconciliationLeaseLostError);
    expect(sideEffects.get(job.expense_id)).toBe(1);
  });

  it("counts a job taken over mid-processing as leaseLost and lets the new owner's write stand", async () => {
    const db = new FakeReconciliationQueue();
    const [job] = db.seed(1);
    const client = db.client();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    isPaid.mockImplementationOnce(async () => {
      await gate;
      return { paid: true } as never;
    });

    // A starts; its heartbeat is too slow to save it.
    const runA = runReconciliationWorker(
      { workerId: "A", syncIntents: false, leaseSeconds: 30, heartbeatMs: 60_000 },
      client,
      noLimit,
    );
    await tick(20);
    db.offsetMs += 31_000;
    // B recovers the job and records it while A is still stuck.
    const resultB = await runReconciliationWorker({ workerId: "B", syncIntents: false }, client, noLimit);
    expect(resultB.recorded).toBe(1);

    release();
    const resultA = await runA;
    expect(resultA).toEqual(expect.objectContaining({ claimed: 1, recorded: 0, leaseLost: 1 }));
    expect(db.rows.get(job.id)?.status).toBe("recorded");
    expect(db.rows.get(job.id)?.lease_owner).toBeNull();
    // A re-checked its lease before the share write and stopped.
    expect(sideEffects.get(job.expense_id)).toBe(1);
  });
});

// ─── 3. Heartbeats ────────────────────────────────────────────────────────────

describe("heartbeats", () => {
  it("keep a long-running job's lease alive so no other worker can claim it", async () => {
    const db = new FakeReconciliationQueue();
    const [job] = db.seed(1);
    const client = db.client();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    isPaid.mockImplementationOnce(async () => {
      await gate;
      return { paid: true } as never;
    });

    const runA = runReconciliationWorker(
      { workerId: "A", syncIntents: false, leaseSeconds: 30, heartbeatMs: 5 },
      client,
      noLimit,
    );
    // 3 x 20 s = 60 s of database time: twice the lease, kept alive by heartbeats.
    for (let i = 0; i < 3; i++) {
      await tick(30);
      db.offsetMs += 20_000;
      await tick(30);
      const intruder = await claimReconciliationJobs(client, { workerId: "B", batchSize: 5 });
      expect(intruder).toHaveLength(0);
    }
    release();
    expect((await runA).recorded).toBe(1);
    expect(db.claims.filter((c) => c.jobId === job.id)).toHaveLength(1);
    expect(sideEffects.get(job.expense_id)).toBe(1);
  });
});

// ─── 4. Retry, dead letter, requeue, poison ──────────────────────────────────

describe("retry backoff and dead-letter handling", () => {
  it("backs off a failing job, dead-letters it when attempts run out, and requeues it on request", async () => {
    const db = new FakeReconciliationQueue();
    const [job] = db.seed(1, { max_attempts: 2 });
    const client = db.client();
    db.failUpdatesFor.add(job.id);

    const first = await runReconciliationWorker({ workerId: "A", syncIntents: false }, client, noLimit);
    expect(first).toEqual(expect.objectContaining({ claimed: 1, pending: 1, deadLettered: 0 }));
    const afterFirst = db.rows.get(job.id)!;
    expect(afterFirst.attempts).toBe(1);
    expect(afterFirst.lease_token).toBeNull();
    expect(Date.parse(afterFirst.next_attempt_at)).toBeGreaterThan(db.now());
    // Stable code only, never the raw error text.
    expect(afterFirst.error_message).toBe("RECONCILIATION_DB_ERROR:57014");
    expect(first.errors).toHaveLength(1);

    // Not due during backoff.
    expect((await runReconciliationWorker({ workerId: "A", syncIntents: false }, client, noLimit)).claimed).toBe(0);

    db.offsetMs += 10 * 60_000;
    const second = await runReconciliationWorker({ workerId: "A", syncIntents: false }, client, noLimit);
    expect(second.deadLettered).toBe(1);
    expect(db.rows.get(job.id)).toEqual(
      expect.objectContaining({ status: "dead_letter", dead_lettered_from: "confirmed_not_recorded", attempts: 2 }),
    );

    // Dead letters are never claimed again on their own.
    db.offsetMs += 60 * 60_000;
    expect((await runReconciliationWorker({ workerId: "A", syncIntents: false }, client, noLimit)).claimed).toBe(0);

    // Staff requeue returns it to where it was; it then reconciles normally.
    db.failUpdatesFor.delete(job.id);
    expect(await requeueReconciliationJob(client, job.id)).toBe(true);
    expect(db.rows.get(job.id)).toEqual(expect.objectContaining({ status: "confirmed_not_recorded", attempts: 0 }));
    expect((await runReconciliationWorker({ workerId: "A", syncIntents: false }, client, noLimit)).recorded).toBe(1);
    expect(await requeueReconciliationJob(client, job.id)).toBe(false);
  });

  it("dead-letters a poison job whose lease keeps expiring", async () => {
    const db = new FakeReconciliationQueue();
    const [job] = db.seed(1, { max_lease_recoveries: 2 });
    const client = db.client();
    for (let i = 0; i < 4; i++) {
      await claimReconciliationJobs(client, { workerId: `crashy-${i}`, batchSize: 1, leaseSeconds: 15 });
      db.offsetMs += 16_000;
    }
    await claimReconciliationJobs(client, { workerId: "sweeper", batchSize: 1 });
    expect(db.rows.get(job.id)).toEqual(
      expect.objectContaining({ status: "dead_letter", dead_letter_reason: "LEASE_EXPIRED_REPEATEDLY", lease_token: null }),
    );
  });

  it("maps failures to stable codes", () => {
    expect(reconciliationFailureCode(new TypeError("secret detail"))).toBe("RECONCILIATION_JOB_FAILED:TypeError");
    expect(reconciliationFailureCode("boom")).toBe("RECONCILIATION_JOB_FAILED:Error");
  });
});

// ─── 5. Deadlines ─────────────────────────────────────────────────────────────

describe("run deadlines", () => {
  it("hands back claims it will not start, without consuming an attempt", async () => {
    const db = new FakeReconciliationQueue();
    db.seed(5);
    const client = db.client();
    const result = await runReconciliationWorker(
      { workerId: "late", syncIntents: false, batchSize: 5, deadline: Date.now() - 1 },
      client,
      noLimit,
    );
    expect(result).toEqual(expect.objectContaining({ claimed: 5, processed: 0, released: 5 }));
    expect([...db.rows.values()].every((row) => row.lease_token === null && row.attempts === 0)).toBe(true);
    // Immediately claimable by the next run.
    expect((await claimReconciliationJobs(client, { workerId: "next", batchSize: 10 })).length).toBe(5);
  });
});

// ─── 6. Backlog throughput ────────────────────────────────────────────────────

describe("backlog load test", () => {
  it("drains a 1,000-job backlog with 4 workers, exactly once per job", async () => {
    const db = new FakeReconciliationQueue();
    const jobs = db.seed(1000);
    const started = Date.now();

    const perWorker = await drain(db, 4, 50);
    const elapsedMs = Date.now() - started;

    const claimed = perWorker.reduce((n, w) => n + w.claimed, 0);
    const recorded = perWorker.reduce((n, w) => n + w.recorded, 0);
    expect(claimed).toBe(1000);
    expect(recorded).toBe(1000);
    expect(perWorker.every((w) => w.leaseLost === 0)).toBe(true);
    // The work spread across the workers instead of serializing on one.
    expect(perWorker.filter((w) => w.claimed > 0).length).toBeGreaterThanOrEqual(2);
    expect(new Set(db.claims.map((c) => c.jobId)).size).toBe(1000);
    expect(db.claims).toHaveLength(1000);
    for (const job of jobs) expect(sideEffects.get(job.expense_id)).toBe(1);

    const throughput = Math.round((1000 / Math.max(elapsedMs, 1)) * 1000);
    console.info(`[reconciliation load test] 1000 jobs, 4 workers, ${elapsedMs} ms, ~${throughput} jobs/s`);
    expect(elapsedMs).toBeLessThan(20_000);
  }, 30_000);
});

// ─── 7. Enqueue, HTTP and SQL guarantees ─────────────────────────────────────

describe("enqueue keys", () => {
  it("dedupes one job per intent, or per tx hash and share", () => {
    expect(reconciliationDedupeKey({ intentId: "i-1", txHash: "AB", expenseId: "e", memberId: "m" })).toBe("intent:i-1");
    expect(reconciliationDedupeKey({ txHash: "ABCD", expenseId: "e", memberId: "m" })).toBe("tx:abcd:e:m");
    expect(reconciliationDedupeKey({ expenseId: "e", memberId: "m", requestId: "r" })).toBe("share:e:m:r");
  });
});

describe("SQL guarantees (migration 0026)", () => {
  const ROOT = path.resolve(__dirname, "../..");
  const sql = fs.readFileSync(path.join(ROOT, "migrations/0026_reconciliation_leased_queue.sql"), "utf8");
  const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

  it("claims with FOR UPDATE SKIP LOCKED and stamps a fresh lease token", () => {
    const start = sql.indexOf("CREATE OR REPLACE FUNCTION public.claim_reconciliation_jobs");
    const claim = sql.slice(start, sql.indexOf("$fn$;", start));
    expect(claim).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(claim).toMatch(/lease_token\s+= gen_random_uuid\(\)/);
    expect(claim).toMatch(/lease_token IS NULL OR lease_expires_at < NOW\(\)/);
  });

  it("fences heartbeat, fail and release on the lease token", () => {
    for (const fn of ["heartbeat_reconciliation_job", "fail_reconciliation_job", "release_reconciliation_job"]) {
      const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${fn}`);
      expect(start).toBeGreaterThan(-1);
      const body = sql.slice(start, sql.indexOf("$fn$;", start));
      expect({ fn, fenced: /lease_token = p_lease_token/.test(body) }).toEqual({ fn, fenced: true });
    }
  });

  it("grants worker RPCs to service_role only and takes UPDATE away from wallets", () => {
    for (const fn of ["claim_reconciliation_jobs", "heartbeat_reconciliation_job", "fail_reconciliation_job", "release_reconciliation_job", "requeue_reconciliation_job"]) {
      expect(sql).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(sql).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\) TO service_role;`));
    }
    expect(sql).toMatch(/REVOKE UPDATE, DELETE ON public\.reconciliation_queue FROM PUBLIC, anon, authenticated;/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS reconciliation_queue_update_parties/);
    expect(sql).toMatch(/enqueue_reconciliation_job[\s\S]*SECURITY INVOKER/);
  });

  it("serializes enqueue per dedupe key, since the partitioned table cannot hold a global unique index", () => {
    expect(sql).toMatch(/pg_advisory_xact_lock\(hashtextextended\('reconciliation_queue:' \|\| v_key, 0\)\)/);
  });

  it("is mirrored into supabase-setup.sql", () => {
    for (const object of [
      "FUNCTION public.claim_reconciliation_jobs",
      "FUNCTION public.heartbeat_reconciliation_job",
      "FUNCTION public.fail_reconciliation_job",
      "FUNCTION public.release_reconciliation_job",
      "FUNCTION public.requeue_reconciliation_job",
      "FUNCTION public.enqueue_reconciliation_job",
      "idx_reconciliation_queue_claimable",
      "idx_reconciliation_queue_lease_expiry",
      "'dead_letter'",
    ]) {
      expect({ object, inSetup: setup.includes(object) }).toEqual({ object, inSetup: true });
    }
  });

  it("documents the claim plan in a query-plan fixture that uses the partial claim index", () => {
    const fixture = JSON.parse(
      fs.readFileSync(path.join(ROOT, "__tests__/database/fixtures/reconciliationQueuePlan.fixture.json"), "utf8"),
    );
    const claim = fixture.fixtures.find((f: { name: string }) => f.name === "reconciliation_claim_due_jobs");
    expect(claim.plan.index_name).toBe("idx_reconciliation_queue_claimable");
    expect(claim.plan.locking_clause).toBe("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("idx_reconciliation_queue_claimable");
    expect(fixture.concurrency.duplicate_claims).toBe(0);
  });
});
