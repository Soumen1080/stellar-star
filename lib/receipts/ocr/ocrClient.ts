/**
 * Client-side OCR API — enqueue, poll, and review OCR jobs.
 *
 * The old flow ran Tesseract entirely in the browser (CPU-heavy, blocking).
 * The new flow:
 *   1. Upload receipt → server stores it (existing flow, unchanged).
 *   2. `enqueueOcr(receiptId)` → enqueue a worker job (fast 202 response).
 *   3. `pollOcrResult(receiptId)` → poll until the worker finishes.
 *   4. User reviews the ReceiptDraft in ReceiptDraftReview (unchanged UI).
 *   5. `reviewOcrResult(receiptId)` → mark as human-reviewed.
 *
 * The old on-device path is kept as a fallback for offline / no-server setups
 * via the existing `recognizeReceipt()` function.
 */

"use client";

import { getAccessToken } from "@/lib/supabase/session";
import type { OcrResult } from "@/lib/receipts/ocr/result";
import type { OcrJob } from "@/lib/receipts/ocr/queue";

export class OcrClientError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, status: number, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "OcrClientError";
    this.status = status;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

async function ocrFetch<T>(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = fetch,
): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new OcrClientError("Sign in to use receipt scanning.", 401);
  const res = await fetchImpl(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const retryAfter = Number(res.headers.get("Retry-After"));
    throw new OcrClientError(
      body?.error || "OCR request failed.",
      res.status,
      Number.isFinite(retryAfter) ? retryAfter : null,
    );
  }
  return body as T;
}

/**
 * Enqueue an OCR job for a receipt. Returns immediately (202).
 */
export async function enqueueOcr(
  receiptId: string,
  fetchImpl?: typeof fetch,
): Promise<OcrJob> {
  const response = await ocrFetch<{ data: OcrJob }>(
    `/api/receipts/${encodeURIComponent(receiptId)}/ocr`,
    { method: "POST" },
    fetchImpl,
  );
  return response.data;
}

export interface OcrPollResponse {
  data: OcrResult | null;
  status?: string;
  error?: string;
}

/**
 * Poll for the OCR result. Returns the result when complete, or the current
 * job status if still processing.
 */
export async function pollOcrResult(
  receiptId: string,
  fetchImpl?: typeof fetch,
): Promise<OcrPollResponse> {
  return ocrFetch<OcrPollResponse>(
    `/api/receipts/${encodeURIComponent(receiptId)}/ocr`,
    {},
    fetchImpl,
  );
}

/**
 * Mark an OCR result as human-reviewed. Required before its data can be used
 * to create or update an expense.
 */
export async function reviewOcrResult(
  receiptId: string,
  fetchImpl?: typeof fetch,
): Promise<OcrResult> {
  const response = await ocrFetch<{ data: OcrResult }>(
    `/api/receipts/${encodeURIComponent(receiptId)}/ocr/review`,
    { method: "POST" },
    fetchImpl,
  );
  return response.data;
}

/**
 * Get the caller's OCR quota usage.
 */
export async function getOcrQuota(
  tripId?: string | null,
  fetchImpl?: typeof fetch,
): Promise<{
  user: { used: number; limit: number; windowSeconds: number };
  trip: { used: number; limit: number; windowSeconds: number } | null;
}> {
  const params = tripId ? `?tripId=${encodeURIComponent(tripId)}` : "";
  const response = await ocrFetch<{ data: ReturnType<typeof getOcrQuota> extends Promise<infer R> ? R : never }>(
    `/api/ocr/quota${params}`,
    {},
    fetchImpl,
  );
  return response.data;
}

/**
 * Poll for OCR result with exponential backoff. Resolves when the result is
 * ready or rejects on failure/timeout.
 */
export async function waitForOcrResult(
  receiptId: string,
  signal: AbortSignal,
  onProgress?: (status: string) => void,
  fetchImpl?: typeof fetch,
): Promise<OcrResult> {
  const MAX_WAIT_MS = 90_000;
  const start = Date.now();
  let interval = 1_000;

  while (!signal.aborted) {
    if (Date.now() - start > MAX_WAIT_MS) {
      throw new OcrClientError("OCR timed out. Try again or enter fields manually.", 408);
    }

    const response = await pollOcrResult(receiptId, fetchImpl);

    if (response.data) {
      return response.data;
    }

    if (response.status === "failed") {
      throw new OcrClientError(
        response.error ?? "OCR processing failed. Try again or enter fields manually.",
        500,
      );
    }

    onProgress?.(response.status ?? "processing");

    // Exponential backoff: 1s, 2s, 4s, capped at 8s.
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, interval);
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new OcrClientError("OCR scan cancelled.", 0));
      }, { once: true });
    });
    interval = Math.min(interval * 2, 8_000);
  }

  throw new OcrClientError("OCR scan cancelled.", 0);
}
