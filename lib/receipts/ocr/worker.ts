/**
 * OCR worker — claims jobs from the queue, runs Tesseract, persists results.
 *
 * Design (issue #452):
 *   - Workers run in background (cron, serverless function, or long-running process).
 *   - Each worker identifies itself with a unique `workerId`.
 *   - Jobs are claimed atomically via `SELECT … FOR UPDATE SKIP LOCKED`.
 *   - Processing is isolated: each job gets its own timeout via AbortController.
 *   - On success, raw text + confidence + parsed fields are saved to `ocr_results`.
 *   - On failure, the job is marked failed with the error; it may be retried up
 *     to `max_attempts` times.
 *   - Workers never write to the `expenses` table. OCR data only flows to
 *     financial records after a human reviews and explicitly approves.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { claimOcrJob, completeOcrJob, type OcrJob } from "./queue";
import { saveOcrResult } from "./result";
import { parseReceiptText } from "./parser";

type Client = SupabaseClient<Database>;

export const OCR_WORKER_TIMEOUT_MS = 60_000;
export const OCR_WORKER_LEASE_SECONDS = 90;
export const OCR_WORKER_POLL_INTERVAL_MS = 5_000;

export interface OcrWorkerOptions {
  /** Unique identifier for this worker instance. */
  workerId: string;
  /** Service-role Supabase client. */
  serviceClient: Client;
  /** Maximum number of jobs to process before stopping (0 = unlimited). */
  maxJobs?: number;
  /** Whether to poll continuously or process one batch and stop. */
  continuous?: boolean;
}

export interface WorkerRunResult {
  processed: number;
  succeeded: number;
  failed: number;
}

/**
 * Process a single OCR job: download the receipt image, run Tesseract on it,
 * parse the text, and persist the result.
 *
 * This runs server-side (Node.js), not in the browser. The existing
 * `parseReceiptText` is reused for field extraction.
 */
async function processJob(
  serviceClient: Client,
  job: OcrJob,
  workerId: string,
): Promise<void> {
  const startMs = Date.now();

  // ── Download the receipt file from storage ────────────────────────────
  const { data: receiptRow } = await serviceClient
    .from("expense_receipts")
    .select("storage_path, content_type")
    .eq("id", job.receiptId)
    .single();

  if (!receiptRow) {
    throw new Error("Receipt not found or has been removed.");
  }

  const storagePath = receiptRow.storage_path as string;
  const { data: fileData, error: downloadError } = await serviceClient
    .storage
    .from("expense-receipts")
    .download(storagePath);

  if (downloadError || !fileData) {
    throw new Error(`Could not download receipt file: ${downloadError?.message ?? "unknown error"}`);
  }

  // ── Run Tesseract (server-side) ───────────────────────────────────────
  // Dynamic import so tesseract.js is only loaded by workers, not by every
  // server module that imports the queue utilities.
  const { createWorker } = await import("tesseract.js");
  const timeoutMs = Math.min(job.timeoutMs, OCR_WORKER_TIMEOUT_MS);

  const worker = await createWorker("eng", 1, {
    cacheMethod: "none",
    errorHandler: () => {}, // Worker errors may contain OCR input: never log them.
  });

  let ocrText = "";
  let ocrConfidence = 0;

  try {
    const buffer = Buffer.from(await fileData.arrayBuffer());

    // Apply the timeout: abort if OCR takes too long.
    const result = await Promise.race([
      worker.recognize(buffer),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("OCR timed out.")), timeoutMs),
      ),
    ]);

    ocrText = result.data.text;
    ocrConfidence = result.data.confidence;
  } finally {
    await worker.terminate().catch(() => {});
  }

  // ── Parse and persist ─────────────────────────────────────────────────
  const draft = parseReceiptText(ocrText, ocrConfidence);
  const processingMs = Date.now() - startMs;

  await saveOcrResult(serviceClient, {
    jobId: job.id,
    receiptId: job.receiptId,
    rawText: ocrText.slice(0, 50_000), // Cap stored text size.
    confidence: ocrConfidence,
    parsedFields: draft.fields,
    lineItems: draft.lineItems,
    engine: "tesseract.js",
    engineVersion: "5",
    workerId,
    processingMs,
  });
}

/**
 * Run the OCR worker loop: claim jobs, process them, persist results.
 *
 * In continuous mode this polls until killed. In batch mode it processes
 * available jobs and returns.
 */
export async function runOcrWorker(options: OcrWorkerOptions): Promise<WorkerRunResult> {
  const { workerId, serviceClient, maxJobs = 0, continuous = false } = options;
  const result: WorkerRunResult = { processed: 0, succeeded: 0, failed: 0 };

  const shouldContinue = () =>
    maxJobs === 0 || result.processed < maxJobs;

  do {
    if (!shouldContinue()) break;

    const job = await claimOcrJob(serviceClient, workerId, OCR_WORKER_LEASE_SECONDS);

    if (!job) {
      if (!continuous) break;
      // Nothing to do — back off before polling again.
      await new Promise((resolve) => setTimeout(resolve, OCR_WORKER_POLL_INTERVAL_MS));
      continue;
    }

    try {
      await processJob(serviceClient, job, workerId);
      await completeOcrJob(serviceClient, job.id, "completed");
      result.succeeded += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      await completeOcrJob(serviceClient, job.id, "failed", message).catch(() => {});
      result.failed += 1;
    }

    result.processed += 1;
  } while (continuous || shouldContinue());

  return result;
}
