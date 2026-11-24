/**
 * OCR job queue — enqueue, claim, complete.
 *
 * The queue is a Postgres table (`ocr_jobs`) with a leased-queue pattern:
 * workers atomically claim jobs with `SELECT … FOR UPDATE SKIP LOCKED`,
 * process them within a time/CPU budget, then mark them completed or failed.
 *
 * This module is server-only (service-role client required).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { checkQuota } from "./quota";

type Client = SupabaseClient<Database>;

export interface EnqueueOcrJobInput {
  receiptId: string;
  expenseId: string;
  tripId?: string | null;
  wallet: string;
  priority?: number;
  timeoutMs?: number;
}

export interface OcrJob {
  id: string;
  receiptId: string;
  expenseId: string | null;
  tripId: string | null;
  wallet: string;
  status: "pending" | "leased" | "completed" | "failed" | "cancelled";
  priority: number;
  leasedAt: string | null;
  leasedBy: string | null;
  leaseExpiresAt: string | null;
  timeoutMs: number;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export class OcrQueueError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "OcrQueueError";
    this.status = status;
  }
}

function rowToJob(row: Record<string, unknown>): OcrJob {
  return {
    id: row.id as string,
    receiptId: (row.receipt_id ?? "") as string,
    expenseId: (row.expense_id as string) ?? null,
    tripId: (row.trip_id as string) ?? null,
    wallet: row.wallet as string,
    status: row.status as OcrJob["status"],
    priority: row.priority as number,
    leasedAt: (row.leased_at as string) ?? null,
    leasedBy: (row.leased_by as string) ?? null,
    leaseExpiresAt: (row.lease_expires_at as string) ?? null,
    timeoutMs: row.timeout_ms as number,
    attempts: row.attempts as number,
    maxAttempts: row.max_attempts as number,
    lastError: (row.last_error as string) ?? null,
    createdAt: row.created_at as string,
    startedAt: (row.started_at as string) ?? null,
    completedAt: (row.completed_at as string) ?? null,
  };
}

/**
 * Enqueue an OCR job for a receipt. Checks per-user and per-trip quotas first.
 * Returns the created job, or throws `OcrQueueError` on quota violation.
 */
export async function enqueueOcrJob(
  serviceClient: Client,
  input: EnqueueOcrJobInput,
): Promise<OcrJob> {
  // ── Quota check ──────────────────────────────────────────────────────
  await checkQuota(serviceClient, {
    wallet: input.wallet,
    tripId: input.tripId ?? null,
  });

  // ── Prevent duplicate jobs for the same receipt ──────────────────────
  const { data: existing } = await serviceClient
    .from("ocr_jobs")
    .select("id, status")
    .eq("receipt_id", input.receiptId)
    .in("status", ["pending", "leased"])
    .limit(1)
    .maybeSingle();
  if (existing) {
    throw new OcrQueueError(
      "An OCR job is already queued or in progress for this receipt.",
      409,
    );
  }

  // ── Enqueue ──────────────────────────────────────────────────────────
  const { data, error } = await serviceClient
    .from("ocr_jobs")
    .insert({
      receipt_id: input.receiptId,
      expense_id: input.expenseId,
      trip_id: input.tripId ?? null,
      wallet: input.wallet,
      priority: input.priority ?? 0,
      timeout_ms: Math.min(input.timeoutMs ?? 60_000, 120_000),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new OcrQueueError("Could not enqueue the OCR job. Please try again.");
  }
  return rowToJob(data);
}

/**
 * Claim the next available OCR job (leased-queue pattern).
 * Returns `null` when no jobs are available.
 */
export async function claimOcrJob(
  serviceClient: Client,
  workerId: string,
  leaseSeconds = 90,
): Promise<OcrJob | null> {
  const { data, error } = await serviceClient
    .rpc("claim_ocr_job", {
      p_worker_id: workerId,
      p_lease_seconds: leaseSeconds,
    });

  if (error) throw new OcrQueueError("Could not claim an OCR job.");
  const rows = Array.isArray(data) ? data : data ? [data] : [];
  if (rows.length === 0) return null;
  return rowToJob(rows[0] as Record<string, unknown>);
}

/**
 * Mark a job as completed or failed.
 */
export async function completeOcrJob(
  serviceClient: Client,
  jobId: string,
  status: "completed" | "failed",
  errorMessage?: string | null,
): Promise<void> {
  const { error } = await serviceClient.rpc("complete_ocr_job", {
    p_job_id: jobId,
    p_status: status,
    p_error: errorMessage ?? null,
  });
  if (error) throw new OcrQueueError("Could not complete the OCR job.");
}

/**
 * Get the job for a receipt (most recent).
 */
export async function getJobForReceipt(
  serviceClient: Client,
  receiptId: string,
): Promise<OcrJob | null> {
  const { data, error } = await serviceClient
    .from("ocr_jobs")
    .select("*")
    .eq("receipt_id", receiptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new OcrQueueError("Could not look up the OCR job.");
  if (!data) return null;
  return rowToJob(data as Record<string, unknown>);
}
