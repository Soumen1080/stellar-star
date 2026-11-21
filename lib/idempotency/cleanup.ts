/**
 * lib/idempotency/cleanup.ts
 *
 * Retention sweep for idempotency records (Issue #414). Server only.
 *
 * One pass, in batches through partial indexes (migration 0024):
 *   - redacts summaries whose replay window has ended,
 *   - deletes audit rows older than IDEMPOTENCY_AUDIT_RETENTION_DAYS,
 *   - deletes pending claims abandoned for IDEMPOTENCY_STALE_PENDING_HOURS,
 * and sweeps this instance's process-local ledger the same way.
 */

import type { ServerClient } from "@/lib/supabase/server";
import { sweepIdempotencyMemory } from "./store";
import {
  IDEMPOTENCY_AUDIT_RETENTION_DAYS,
  IDEMPOTENCY_PURGE_BATCH_SIZE,
  IDEMPOTENCY_STALE_PENDING_HOURS,
} from "./retention";

export interface IdempotencyPurgeResult {
  redacted: number;
  deleted: number;
  stalePendingDeleted: number;
  memoryRemoved: number;
  batchSize: number;
}

export class IdempotencyPurgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdempotencyPurgeError";
  }
}

export async function purgeIdempotencyRecords(
  client: ServerClient | null,
  { now = Date.now(), batchSize = IDEMPOTENCY_PURGE_BATCH_SIZE }: { now?: number; batchSize?: number } = {},
): Promise<IdempotencyPurgeResult> {
  const memoryRemoved = sweepIdempotencyMemory(now);
  if (!client) {
    return { redacted: 0, deleted: 0, stalePendingDeleted: 0, memoryRemoved, batchSize };
  }

  const { data, error } = await client.rpc("purge_idempotency_records", {
    p_now: new Date(now).toISOString(),
    p_batch_size: batchSize,
    p_audit_retention_days: IDEMPOTENCY_AUDIT_RETENTION_DAYS,
    p_stale_pending_hours: IDEMPOTENCY_STALE_PENDING_HOURS,
  });
  if (error) throw new IdempotencyPurgeError("The idempotency retention sweep failed.");

  const result = (data ?? {}) as Record<string, unknown>;
  return {
    redacted: Number(result.redacted ?? 0),
    deleted: Number(result.deleted ?? 0),
    stalePendingDeleted: Number(result.stale_pending_deleted ?? 0),
    memoryRemoved,
    batchSize: Number(result.batch_size ?? batchSize),
  };
}
