/**
 * __tests__/settlement/fakeReconciliationQueue.ts
 *
 * In-memory stand-in for public.reconciliation_queue and the migration 0026
 * RPCs (#416), for driving the real worker code concurrently in Jest.
 *
 * Each RPC is atomic, as the SQL function is in its own transaction. The
 * claim filters, orders and stamps leases the way claim_reconciliation_jobs()
 * does; heartbeat, fail, release and requeue apply the same predicates; and
 * `.update().eq("id").eq("lease_token")` reproduces the fenced PostgREST
 * write. Every call yields to the event loop first, so concurrent workers
 * interleave between database round trips, as they would in production.
 *
 * The SQL itself is checked against PostgreSQL by the migration tests and
 * the query-plan fixture. This fake lets the TypeScript side of the
 * protocol be tested.
 */

import { randomUUID } from "crypto";
import type { ReconciliationJobRow } from "@/types/supabase";

const ACTIVE = new Set(["not_submitted", "submitted_not_confirmed", "confirmed_not_recorded"]);

type Row = ReconciliationJobRow;
type Filter = { column: string; op: "eq" | "in"; value: unknown };

export interface ClaimRecord {
  workerId: string;
  jobId: string;
  token: string;
  recovery: boolean;
}

export class FakeReconciliationQueue {
  readonly rows = new Map<string, Row>();
  /** Every lease ever granted, in order. */
  readonly claims: ClaimRecord[] = [];
  /** Database clock offset; advance it to make leases expire. */
  offsetMs = 0;
  /** Job ids whose next fenced update fails with a database error. */
  readonly failUpdatesFor = new Set<string>();
  runInserts: Array<Record<string, unknown>> = [];

  now(): number {
    return Date.now() + this.offsetMs;
  }

  private iso(ms: number): string {
    return new Date(ms).toISOString();
  }

  seed(count: number, overrides: Partial<Row> = {}): Row[] {
    const created: Row[] = [];
    const base = this.now();
    for (let i = 0; i < count; i++) {
      const row: Row = {
        id: randomUUID(),
        intent_id: null,
        trip_id: "trip-load",
        expense_id: `expense-${i}`,
        member_id: `member-${i}`,
        payer_wallet: "GPAYER".padEnd(56, "A"),
        member_wallet: "GMEMBER".padEnd(56, "B"),
        asset: "native",
        amount: "1.0000000",
        amount_stroops: "10000000",
        expected_memo: null,
        request_id: `req-${i}`,
        tx_hash: (i.toString(16).padStart(8, "0") + "f".repeat(56)).slice(0, 64),
        ledger: 100,
        status: "confirmed_not_recorded",
        attempts: 0,
        max_attempts: 10,
        backoff_ms: 5000,
        last_attempt_at: null,
        next_attempt_at: this.iso(base - 1000),
        escalation_reason: null,
        error_message: null,
        verified_at: this.iso(base - 1000),
        recorded_at: null,
        created_at: this.iso(base - 60_000 + i),
        updated_at: this.iso(base - 60_000 + i),
        dedupe_key: null,
        lease_owner: null,
        lease_token: null,
        leased_at: null,
        lease_expires_at: null,
        heartbeat_at: null,
        claim_count: 0,
        lease_recoveries: 0,
        max_lease_recoveries: 3,
        dead_lettered_at: null,
        dead_lettered_from: null,
        dead_letter_reason: null,
        ...overrides,
      };
      this.rows.set(row.id, row);
      created.push(row);
    }
    return created;
  }

  private leaseExpired(row: Row): boolean {
    return row.lease_token !== null && Date.parse(row.lease_expires_at as string) < this.now();
  }

  private clearLease(row: Row): void {
    row.lease_owner = null;
    row.lease_token = null;
    row.lease_expires_at = null;
  }

  // ── RPCs (mirror migrations/0026_reconciliation_leased_queue.sql) ─────────

  private claim(workerId: string, batchSize: number, leaseSeconds: number): Row[] {
    const batch = Math.min(Math.max(batchSize || 15, 1), 50);
    const lease = Math.min(Math.max(leaseSeconds || 90, 15), 900);
    const now = this.now();

    for (const row of this.rows.values()) {
      if (ACTIVE.has(row.status) && this.leaseExpired(row) && row.lease_recoveries >= row.max_lease_recoveries) {
        row.dead_lettered_from = row.status;
        row.status = "dead_letter";
        row.dead_lettered_at = this.iso(now);
        row.dead_letter_reason = "LEASE_EXPIRED_REPEATEDLY";
        this.clearLease(row);
      }
    }

    const claimable = [...this.rows.values()]
      .filter(
        (row) =>
          ACTIVE.has(row.status) &&
          Date.parse(row.next_attempt_at) <= now &&
          (row.lease_token === null || this.leaseExpired(row)),
      )
      .sort((a, b) =>
        a.next_attempt_at === b.next_attempt_at
          ? a.created_at.localeCompare(b.created_at)
          : a.next_attempt_at.localeCompare(b.next_attempt_at),
      )
      .slice(0, batch);

    return claimable.map((row) => {
      const recovery = row.lease_token !== null;
      row.lease_owner = workerId;
      row.lease_token = randomUUID();
      row.leased_at = this.iso(now);
      row.lease_expires_at = this.iso(now + lease * 1000);
      row.heartbeat_at = this.iso(now);
      row.claim_count += 1;
      row.lease_recoveries += recovery ? 1 : 0;
      this.claims.push({ workerId, jobId: row.id, token: row.lease_token, recovery });
      return { ...row };
    });
  }

  private heartbeat(id: string, token: string, leaseSeconds: number): boolean {
    const row = this.rows.get(id);
    if (!row || row.lease_token !== token || !ACTIVE.has(row.status)) return false;
    const lease = Math.min(Math.max(leaseSeconds || 90, 15), 900);
    row.lease_expires_at = this.iso(this.now() + lease * 1000);
    row.heartbeat_at = this.iso(this.now());
    return true;
  }

  private fail(id: string, token: string, code: string, backoffMs: number): string {
    const row = this.rows.get(id);
    if (!row || row.lease_token !== token) return "lease_lost";
    const cleanCode = (code || "RECONCILIATION_JOB_FAILED").replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
    const exhausted = row.attempts + 1 >= row.max_attempts;
    row.attempts += 1;
    row.last_attempt_at = this.iso(this.now());
    row.error_message = cleanCode;
    if (exhausted) {
      row.dead_lettered_from = row.status;
      row.status = "dead_letter";
      row.dead_lettered_at = this.iso(this.now());
      row.dead_letter_reason = cleanCode;
    }
    row.next_attempt_at = this.iso(this.now() + Math.min(Math.max(backoffMs, 0), 3_600_000));
    this.clearLease(row);
    return exhausted ? "dead_letter" : "retry";
  }

  private release(id: string, token: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.lease_token !== token) return false;
    this.clearLease(row);
    return true;
  }

  private requeue(id: string): boolean {
    const row = this.rows.get(id);
    if (!row || row.status !== "dead_letter" || row.lease_token !== null) return false;
    row.status = (row.dead_lettered_from ??
      (row.tx_hash === null ? "not_submitted" : row.verified_at ? "confirmed_not_recorded" : "submitted_not_confirmed")) as Row["status"];
    row.attempts = 0;
    row.lease_recoveries = 0;
    row.next_attempt_at = this.iso(this.now());
    row.dead_lettered_at = null;
    row.dead_lettered_from = null;
    row.dead_letter_reason = null;
    row.error_message = null;
    return true;
  }

  // ── Client surface used by the worker ─────────────────────────────────────

  client(): any {
    const db = this;
    return {
      async rpc(name: string, args: Record<string, any>) {
        await new Promise((resolve) => setImmediate(resolve));
        switch (name) {
          case "claim_reconciliation_jobs":
            return { data: db.claim(args.p_worker_id, args.p_batch_size, args.p_lease_seconds), error: null };
          case "heartbeat_reconciliation_job":
            return { data: db.heartbeat(args.p_id, args.p_lease_token, args.p_lease_seconds), error: null };
          case "fail_reconciliation_job":
            return { data: db.fail(args.p_id, args.p_lease_token, args.p_error_code, args.p_backoff_ms), error: null };
          case "release_reconciliation_job":
            return { data: db.release(args.p_id, args.p_lease_token), error: null };
          case "requeue_reconciliation_job":
            return { data: db.requeue(args.p_id), error: null };
          default:
            return { data: null, error: { message: `unknown rpc ${name}`, code: "42883" } };
        }
      },
      from(table: string) {
        return db.table(table);
      },
    };
  }

  private table(table: string): any {
    const db = this;
    const filters: Filter[] = [];
    let updates: Record<string, unknown> | null = null;
    let returning = false;

    const matches = (row: Row) =>
      filters.every((f) =>
        f.op === "eq"
          ? (row as Record<string, unknown>)[f.column] === f.value
          : (f.value as unknown[]).includes((row as Record<string, unknown>)[f.column]),
      );

    const execute = async () => {
      await new Promise((resolve) => setImmediate(resolve));
      if (table === "reconciliation_worker_runs") return { data: null, error: null };
      if (table === "settlement_intents") return { data: [], error: null };
      if (updates) {
        const target = [...db.rows.values()].filter(matches);
        if (target.some((row) => db.failUpdatesFor.has(row.id))) {
          return { data: null, error: { message: "simulated write failure", code: "57014" } };
        }
        for (const row of target) Object.assign(row, updates);
        return { data: returning ? target.map((row) => ({ id: row.id })) : null, error: null };
      }
      return { data: [...db.rows.values()].filter(matches).map((row) => ({ ...row })), error: null };
    };

    const builder: any = {
      insert: async (row: Record<string, unknown>) => {
        if (table === "reconciliation_worker_runs") db.runInserts.push(row);
        return { error: null };
      },
      select: () => {
        returning = true;
        return builder;
      },
      update: (values: Record<string, unknown>) => {
        updates = values;
        return builder;
      },
      eq: (column: string, value: unknown) => {
        filters.push({ column, op: "eq", value });
        return builder;
      },
      in: (column: string, value: unknown[]) => {
        filters.push({ column, op: "in", value });
        return builder;
      },
      or: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) => execute().then(resolve, reject),
    };
    return builder;
  }
}
