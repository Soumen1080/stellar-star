/**
 * POST /api/receipts/:receiptId/ocr — Enqueue an OCR job for a receipt.
 * GET  /api/receipts/:receiptId/ocr — Poll for OCR result.
 *
 * The POST is fast: it validates authorization, checks quotas, and enqueues.
 * No OCR happens inline — that's the worker's job.
 *
 * The GET returns the latest OCR result for the receipt, or 202 if the job
 * is still processing.
 */

import { NextResponse, type NextRequest } from "next/server";
import {
  receiptClients,
  receiptError,
  receiptJson,
  isUuid,
  RECEIPT_RESPONSE_HEADERS,
} from "@/lib/receipts/http";
import { loadExpenseAccess, loadReceipt } from "@/lib/receipts/store";
import { canUploadReceipt } from "@/lib/receipts/access";
import { enqueueOcrJob, getJobForReceipt, OcrQueueError } from "@/lib/receipts/ocr/queue";
import { OcrQuotaError } from "@/lib/receipts/ocr/quota";
import { getOcrResult } from "@/lib/receipts/ocr/result";

type RouteContext = { params: Promise<{ receiptId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Invalid receipt ID.", 400);

  const auth = receiptClients(request);
  if ("response" in auth) return auth.response;
  const { wallet, userClient, serviceClient } = auth;

  try {
    // Load the receipt via RLS (membership check).
    const record = await loadReceipt(userClient, receiptId);
    if (!record) return receiptError("Receipt not found.", 404);

    // Load expense access to verify upload permission.
    if (!record.receipt.expenseId) return receiptError("Receipt is not linked to an expense.", 400);
    const access = await loadExpenseAccess(userClient, record.receipt.expenseId);
    if (!access) return receiptError("Expense not found.", 404);
    if (!canUploadReceipt(access, wallet)) {
      return receiptError("You do not have permission to scan this receipt.", 403);
    }

    // Look up the trip for per-trip quota.
    const { data: tripData } = await serviceClient
      .from("trips")
      .select("id")
      .contains("expense_ids", [record.receipt.expenseId])
      .limit(1)
      .maybeSingle();

    const job = await enqueueOcrJob(serviceClient, {
      receiptId,
      expenseId: record.receipt.expenseId,
      tripId: tripData?.id ?? null,
      wallet,
    });

    return receiptJson({ data: job }, 202);
  } catch (err) {
    if (err instanceof OcrQuotaError) {
      return NextResponse.json(
        { error: err.message },
        {
          status: 429,
          headers: {
            ...RECEIPT_RESPONSE_HEADERS,
            ...(err.retryAfterSeconds
              ? { "Retry-After": String(err.retryAfterSeconds) }
              : {}),
          },
        },
      );
    }
    if (err instanceof OcrQueueError) {
      return receiptError(err.message, err.status);
    }
    return receiptError("Something went wrong. Please try again.", 500);
  }
}

export async function GET(request: NextRequest, context: RouteContext) {
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Invalid receipt ID.", 400);

  const auth = receiptClients(request);
  if ("response" in auth) return auth.response;
  const { userClient, serviceClient } = auth;

  // Membership check via RLS.
  const record = await loadReceipt(userClient, receiptId);
  if (!record) return receiptError("Receipt not found.", 404);

  // Check if there's a completed result.
  const result = await getOcrResult(serviceClient, receiptId);
  if (result) {
    return receiptJson({ data: result });
  }

  // Check job status.
  const job = await getJobForReceipt(serviceClient, receiptId);
  if (!job) {
    return receiptJson({ data: null, status: "no_job" });
  }

  if (job.status === "failed") {
    return receiptJson(
      { data: null, status: "failed", error: job.lastError ?? "OCR processing failed." },
      200,
    );
  }

  // Still processing — return 202.
  return receiptJson({ data: null, status: job.status }, 202);
}
