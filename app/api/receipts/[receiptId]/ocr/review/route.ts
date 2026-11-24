/**
 * POST /api/receipts/:receiptId/ocr/review — Mark OCR result as human-reviewed.
 *
 * This is the gate between OCR suggestions and financial writes. An OCR result
 * must be explicitly reviewed before its data can flow into an expense.
 *
 * The route verifies:
 *   1. The caller is authenticated and can see the receipt (RLS).
 *   2. The caller uploaded the receipt or created the expense.
 *   3. An OCR result exists and has not already been reviewed.
 */

import { type NextRequest } from "next/server";
import {
  receiptClients,
  receiptError,
  receiptJson,
  isUuid,
} from "@/lib/receipts/http";
import { loadExpenseAccess, loadReceipt } from "@/lib/receipts/store";
import { canUploadReceipt } from "@/lib/receipts/access";
import { getOcrResult, markOcrResultReviewed, OcrResultError } from "@/lib/receipts/ocr/result";

type RouteContext = { params: Promise<{ receiptId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Invalid receipt ID.", 400);

  const auth = receiptClients(request);
  if ("response" in auth) return auth.response;
  const { wallet, userClient, serviceClient } = auth;

  try {
    // Load receipt via RLS.
    const record = await loadReceipt(userClient, receiptId);
    if (!record) return receiptError("Receipt not found.", 404);
    if (!record.receipt.expenseId) return receiptError("Receipt is not linked to an expense.", 400);

    // Authorization: must be uploader or expense creator.
    const access = await loadExpenseAccess(userClient, record.receipt.expenseId);
    if (!access) return receiptError("Expense not found.", 404);
    if (!canUploadReceipt(access, wallet)) {
      return receiptError("You do not have permission to review this OCR result.", 403);
    }

    // Load the OCR result.
    const result = await getOcrResult(serviceClient, receiptId);
    if (!result) return receiptError("No OCR result exists for this receipt.", 404);
    if (result.reviewed) return receiptError("This OCR result has already been reviewed.", 409);

    // Mark as reviewed.
    const updated = await markOcrResultReviewed(serviceClient, result.id, wallet);
    return receiptJson({ data: updated });
  } catch (err) {
    if (err instanceof OcrResultError) {
      return receiptError(err.message, err.status);
    }
    return receiptError("Something went wrong. Please try again.", 500);
  }
}
