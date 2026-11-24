/**
 * lib/settlement/reconciliationQueue.ts
 *
 * The leased work-queue protocol behind settlement reconciliation (Issue #416).
 * Server only: every function here takes the service-role client, and the
 * worker RPCs are granted to service_role alone (migration 0026).
 *
 * Lifecycle of a job:
 *
 *   enqueue ─► claim ─► (heartbeat …) ─► fenced transition ─► claimable again
 *                │                                │            or terminal
 *                │                                └─ fail ─► backoff / dead_letter
 *                └─ lease expires (worker died) ─► re-claimed by another worker,
 *                                                  dead-lettered once
 *                                                  max_lease_recoveries is spent
 *
 * - claim_reconciliation_jobs() selects due rows FOR UPDATE SKIP LOCKED and
 *   gives each a fresh lease token. Two workers never receive the same job.
 * - Each worker write is fenced on (id, lease_token). After a re-claim the
 *   previous holder's token no longer matches, so its late writes are
 *   discarded instead of overwriting the new holder's progress.
 * - A heartbeat extends the lease while a job runs. When it fails, the worker
 *   has lost the job and stops before any further side effect.
 */

import type { StellarStarClient } from "@/lib/supabase/client";
import { DatabaseError } from "@/lib/supabase/queries";
import type { ReconciliationJobRow } from "@/types/supabase";
import type { ReconciliationJob } from "@/types/reconciliation";

/** A claim is valid this long without a heartbeat. */
export const RECONCILIATION_LEASE_SECONDS = 90;
/** Heartbeat interval: a third of the lease, so two missed beats still hold it. */
export const RECONCILIATION_HEARTBEAT_MS = 30_000;

export const ACTIVE_RECONCILIATION_STATUSES = [
  "not_submitted",
  "submitted_not_confirmed",
  "confirmed_not_recorded",
] as const;

/** Thrown when a worker finds that it no longer holds a job's lease. */
export class ReconciliationLeaseLostError extends Error {
  readonly code = "RECONCILIATION_LEASE_LOST";
  readonly jobId: string;

  constructor(jobId: string) {
    super(`Lease on reconciliation job ${jobId} is no longer held by this worker.`);
    this.name = "ReconciliationLeaseLostError";
    this.jobId = jobId;
  }
}

export type FailOutcome = "retry" | "dead_letter" | "lease_lost";

export interface ClaimedReconciliationRow {
  row: ReconciliationJobRow;
  leaseToken: string;
}

function rpcError(error: { message: string; code?: string }, operation: string): DatabaseError {
  return new DatabaseError(error.message, error.code, operation);
}

/** A fresh lease-owner ID. One per run, so its claims can be traced in the run log. */
export function newReconciliationWorkerId(): string {
  return `reconciliation-${crypto.randomUUID()}`;
}

/** Deterministic key so a job is enqueued at most once per payment. */
export function reconciliationDedupeKey(params: {
  intentId?: string | null;
  txHash?: string | null;
  expenseId: string;
  memberId: string;
  requestId?: string | null;
}): string {
  if (params.intentId) return `intent:${params.intentId}`;
  if (params.txHash) return `tx:${params.txHash.trim().toLowerCase()}:${params.expenseId}:${params.memberId}`;
  return `share:${params.expenseId}:${params.memberId}:${params.requestId ?? "none"}`;
}

/** Claims up to `batchSize` due jobs for `workerId` (FOR UPDATE SKIP LOCKED). */
export async function claimReconciliationJobs(
  client: StellarStarClient,
  options: { workerId: string; batchSize: number; leaseSeconds?: number },
): Promise<ClaimedReconciliationRow[]> {
  const { data, error } = await client.rpc("claim_reconciliation_jobs", {
    p_worker_id: options.workerId,
    p_batch_size: options.batchSize,
    p_lease_seconds: options.leaseSeconds ?? RECONCILIATION_LEASE_SECONDS,
  });
  if (error) throw rpcError(error, "claim reconciliation jobs");
  const rows = (Array.isArray(data) ? data : []) as ReconciliationJobRow[];
  return rows
    .filter((row) => typeof row.lease_token === "string" && row.lease_token.length > 0)
    .map((row) => ({ row, leaseToken: row.lease_token as string }));
}

/** Extends the lease. False means another worker now owns the job, or it finished. */
export async function heartbeatReconciliationJob(
  client: StellarStarClient,
  jobId: string,
  leaseToken: string,
  leaseSeconds = RECONCILIATION_LEASE_SECONDS,
): Promise<boolean> {
  const { data, error } = await client.rpc("heartbeat_reconciliation_job", {
    p_id: jobId,
    p_lease_token: leaseToken,
    p_lease_seconds: leaseSeconds,
  });
  if (error) throw rpcError(error, "heartbeat reconciliation job");
  return data === true;
}

/**
 * Records a processing failure: consumes an attempt and schedules a retry
 * after `backoffMs`, or dead-letters the job when its attempts are exhausted.
 * `errorCode` must be a stable code; free-form error text is never stored.
 */
export async function failReconciliationJob(
  client: StellarStarClient,
  jobId: string,
  leaseToken: string,
  errorCode: string,
  backoffMs: number,
): Promise<FailOutcome> {
  const { data, error } = await client.rpc("fail_reconciliation_job", {
    p_id: jobId,
    p_lease_token: leaseToken,
    p_error_code: errorCode,
    p_backoff_ms: Math.max(0, Math.round(backoffMs)),
  });
  if (error) throw rpcError(error, "fail reconciliation job");
  return data === "dead_letter" || data === "retry" ? data : "lease_lost";
}

/** Returns an unprocessed claim to the queue without consuming an attempt. */
export async function releaseReconciliationJob(
  client: StellarStarClient,
  jobId: string,
  leaseToken: string,
): Promise<boolean> {
  const { data, error } = await client.rpc("release_reconciliation_job", {
    p_id: jobId,
    p_lease_token: leaseToken,
  });
  if (error) throw rpcError(error, "release reconciliation job");
  return data === true;
}

/** Staff action: returns a dead-lettered job to the state it was dead-lettered from. */
export async function requeueReconciliationJob(client: StellarStarClient, jobId: string): Promise<boolean> {
  const { data, error } = await client.rpc("requeue_reconciliation_job", { p_id: jobId });
  if (error) throw rpcError(error, "requeue reconciliation job");
  return data === true;
}

/** Columns that hand a job's lease back when a fenced transition lands. */
export const LEASE_RELEASE_FIELDS = {
  lease_owner: null,
  lease_token: null,
  lease_expires_at: null,
} as const;

export interface LeaseOptions {
  leaseSeconds?: number;
  heartbeatMs?: number;
}

/**
 * One worker's hold on one job. `start()` heartbeats in the background;
 * `assertHeld()` checks the lease synchronously with the database before an
 * irreversible step. Once lost, a lease stays lost.
 */
export class ReconciliationLease {
  readonly jobId: string;
  readonly token: string;
  private readonly client: StellarStarClient;
  private readonly leaseSeconds: number;
  private readonly heartbeatMs: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private inFlight: Promise<void> | null = null;
  private _lost = false;
  private _released = false;

  constructor(client: StellarStarClient, jobId: string, token: string, options: LeaseOptions = {}) {
    this.client = client;
    this.jobId = jobId;
    this.token = token;
    this.leaseSeconds = options.leaseSeconds ?? RECONCILIATION_LEASE_SECONDS;
    this.heartbeatMs = options.heartbeatMs ?? RECONCILIATION_HEARTBEAT_MS;
  }

  get lost(): boolean {
    return this._lost;
  }

  /** True once a fenced write or fail/release call has handed the lease back. */
  get released(): boolean {
    return this._released;
  }

  markLost(): void {
    this._lost = true;
    this.stop();
  }

  markReleased(): void {
    this._released = true;
    this.stop();
  }

  start(): void {
    if (this.timer || this._lost || this._released) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return;
      this.inFlight = this.beat()
        .then(
          () => undefined,
          () => {
            // A failed heartbeat is not proof the lease is gone; assertHeld()
            // and the fenced write decide that.
          },
        )
        .finally(() => {
          this.inFlight = null;
        });
    }, this.heartbeatMs);
    // Never keep a serverless invocation or test process alive for a heartbeat.
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async beat(): Promise<boolean> {
    if (this._lost || this._released) return !this._lost;
    const held = await heartbeatReconciliationJob(this.client, this.jobId, this.token, this.leaseSeconds);
    if (!held) this.markLost();
    return held;
  }

  /** Confirms (and extends) the lease, or throws ReconciliationLeaseLostError. */
  async assertHeld(): Promise<void> {
    if (this._lost) throw new ReconciliationLeaseLostError(this.jobId);
    const held = await this.beat();
    if (!held) throw new ReconciliationLeaseLostError(this.jobId);
  }
}

/** Maps any thrown value to a stable, storable failure code. */
export function reconciliationFailureCode(err: unknown): string {
  if (err instanceof DatabaseError) {
    return `RECONCILIATION_DB_ERROR${err.code ? `:${err.code}` : ""}`;
  }
  const name = err instanceof Error && err.name ? err.name : "Error";
  return `RECONCILIATION_JOB_FAILED:${name}`.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 120);
}

export type { ReconciliationJob };
