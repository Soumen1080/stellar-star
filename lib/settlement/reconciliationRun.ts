/**
 * lib/settlement/reconciliationRun.ts
 *
 * One bounded, recorded reconciliation run (Issue #415). Server only.
 *
 * A run drains due jobs in batches of at most RECONCILIATION_MAX_BATCH_SIZE,
 * stopping after RECONCILIATION_MAX_BATCHES batches, once the queue is
 * drained, or when RECONCILIATION_RUN_TIME_BUDGET_MS has passed, whichever
 * comes first. Every run, successful or not, is recorded with its actor,
 * request ID, trigger, duration and result. It goes to the
 * `reconciliation_worker_runs` table (migration 0025), a structured log line,
 * and a short in-process history.
 *
 * Per-job error messages are returned to the trusted caller but never
 * persisted; the record keeps only the IDs of jobs that errored.
 */

import type { ServerClient } from "@/lib/supabase/server";
import { runReconciliationWorker } from "./reconciliationWorker";
import type { ReconciliationActor } from "./reconciliationAuth";
import type { ReconciliationWorkerRunResult } from "@/types/reconciliation";

export const RECONCILIATION_DEFAULT_BATCH_SIZE = 15;
export const RECONCILIATION_MAX_BATCH_SIZE = 50;
export const RECONCILIATION_MAX_BATCHES = 8;
export const RECONCILIATION_RUN_TIME_BUDGET_MS = 45_000;
const MAX_ERRORED_JOB_IDS = 20;
const MEMORY_HISTORY = 50;

export type ReconciliationTrigger = "schedule" | "manual";

export interface ReconciliationRunRecord {
  id: string;
  requestId: string;
  actorKind: ReconciliationActor["kind"];
  actorId: string;
  trigger: ReconciliationTrigger;
  batchSize: number;
  batches: number;
  walletFilter: string | null;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  outcome: "succeeded" | "failed";
  processed: number;
  recorded: number;
  escalated: number;
  pending: number;
  failed: number;
  errorCount: number;
  erroredJobIds: string[];
  /** Stable code only; the underlying cause goes to redacted telemetry. */
  failureCode: string | null;
}

export interface ReconciliationRunOutcome {
  record: ReconciliationRunRecord;
  /** Per-job detail for the trusted caller; not persisted. */
  errors: ReconciliationWorkerRunResult["errors"];
}

/** Clamps a requested batch size to 1..RECONCILIATION_MAX_BATCH_SIZE. */
export function clampBatchSize(requested: unknown): number {
  const n = typeof requested === "number" ? requested : Number(requested);
  if (!Number.isFinite(n)) return RECONCILIATION_DEFAULT_BATCH_SIZE;
  return Math.min(RECONCILIATION_MAX_BATCH_SIZE, Math.max(1, Math.floor(n)));
}

declare global {
  var stellarStarReconciliationRuns: ReconciliationRunRecord[] | undefined;
}
const history: ReconciliationRunRecord[] = globalThis.stellarStarReconciliationRuns ?? [];
globalThis.stellarStarReconciliationRuns = history;

type Worker = typeof runReconciliationWorker;

export interface ExecuteRunOptions {
  actor: ReconciliationActor;
  requestId: string;
  trigger: ReconciliationTrigger;
  client: ServerClient;
  batchSize?: unknown;
  walletAddress?: string | null;
  maxBatches?: number;
  timeBudgetMs?: number;
  /** Injection points for tests. */
  worker?: Worker;
  clock?: () => number;
}

export async function executeReconciliationRun(options: ExecuteRunOptions): Promise<ReconciliationRunOutcome> {
  const clock = options.clock ?? Date.now;
  const worker = options.worker ?? runReconciliationWorker;
  const batchSize = clampBatchSize(options.batchSize ?? RECONCILIATION_DEFAULT_BATCH_SIZE);
  const maxBatches = Math.max(1, Math.min(options.maxBatches ?? RECONCILIATION_MAX_BATCHES, RECONCILIATION_MAX_BATCHES));
  const budget = options.timeBudgetMs ?? RECONCILIATION_RUN_TIME_BUDGET_MS;
  const walletFilter = options.walletAddress?.trim() || null;

  const started = clock();
  const totals = { processed: 0, recorded: 0, escalated: 0, pending: 0, failed: 0 };
  const errors: ReconciliationWorkerRunResult["errors"] = [];
  let batches = 0;
  let failureCode: string | null = null;

  try {
    while (batches < maxBatches) {
      const result = await worker({ batchSize, walletAddress: walletFilter ?? undefined }, options.client as never);
      batches += 1;
      totals.processed += result.processed;
      totals.recorded += result.recorded;
      totals.escalated += result.escalated;
      totals.pending += result.pending;
      totals.failed += result.failed;
      errors.push(...result.errors);
      // A short batch means the due queue is drained.
      if (result.processed < batchSize) break;
      if (clock() - started >= budget) break;
    }
  } catch (err) {
    failureCode = "RECONCILIATION_RUN_FAILED";
    console.error(
      `[reconciliation:run] ${JSON.stringify({
        requestId: options.requestId,
        event: "run-failed",
        message: err instanceof Error ? err.message : String(err),
      })}`,
    );
  }

  const finished = clock();
  const record: ReconciliationRunRecord = {
    id: crypto.randomUUID(),
    requestId: options.requestId,
    actorKind: options.actor.kind,
    actorId: options.actor.id,
    trigger: options.trigger,
    batchSize,
    batches,
    walletFilter,
    startedAt: new Date(started).toISOString(),
    finishedAt: new Date(finished).toISOString(),
    durationMs: finished - started,
    outcome: failureCode ? "failed" : "succeeded",
    ...totals,
    errorCount: errors.length,
    erroredJobIds: errors.slice(0, MAX_ERRORED_JOB_IDS).map((e) => e.jobId),
    failureCode,
  };

  await recordReconciliationRun(record, options.client);
  return { record, errors };
}

/** Persists a run record. Never throws: a logging failure must not fail the run. */
export async function recordReconciliationRun(record: ReconciliationRunRecord, client: ServerClient | null): Promise<void> {
  history.unshift(record);
  if (history.length > MEMORY_HISTORY) history.length = MEMORY_HISTORY;

  console.info(`[reconciliation:run] ${JSON.stringify({ event: "run-recorded", ...record })}`);

  if (!client) return;
  try {
    const { error } = await (client as any).from("reconciliation_worker_runs").insert({
      id: record.id,
      request_id: record.requestId,
      actor_kind: record.actorKind,
      actor_id: record.actorId,
      trigger: record.trigger,
      batch_size: record.batchSize,
      batches: record.batches,
      wallet_filter: record.walletFilter,
      started_at: record.startedAt,
      finished_at: record.finishedAt,
      duration_ms: record.durationMs,
      outcome: record.outcome,
      processed: record.processed,
      recorded: record.recorded,
      escalated: record.escalated,
      pending: record.pending,
      failed: record.failed,
      error_count: record.errorCount,
      errored_job_ids: record.erroredJobIds,
      failure_code: record.failureCode,
    });
    if (error) {
      console.warn(`[reconciliation:run] ${JSON.stringify({ requestId: record.requestId, event: "record-insert-failed" })}`);
    }
  } catch {
    console.warn(`[reconciliation:run] ${JSON.stringify({ requestId: record.requestId, event: "record-insert-failed" })}`);
  }
}

/** Recent runs in this process, newest first. */
export function recentReconciliationRuns(limit = 10): ReconciliationRunRecord[] {
  return history.slice(0, Math.max(0, Math.min(limit, MEMORY_HISTORY)));
}

export function __resetReconciliationRunsForTests(): void {
  history.length = 0;
}
