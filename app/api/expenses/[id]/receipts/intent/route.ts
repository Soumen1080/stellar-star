import type { NextRequest } from "next/server";
import { hasExpensePermission } from "@/lib/supabase/queries";
import { receiptMaxBytes, RECEIPT_CONTENT_TYPES } from "@/lib/receipts/policy";
import { loadExpenseAccess } from "@/lib/receipts/store";
import { createUploadIntent, DEFAULT_UPLOAD_INTENT_TTL_SECONDS, ReceiptIntentError } from "@/lib/receipts/intent";
import {
  errorResponse,
  isUuid,
  receiptClients,
  receiptError,
  receiptJson,
} from "@/lib/receipts/http";
import { enforceAbuseProtection } from "@/lib/security/abuseProtection";
import { requireIdempotencyKey } from "@/lib/idempotency/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * POST /api/expenses/:id/receipts/intent
 *
 * Creates a short-lived upload intent for attaching a receipt (issue #451).
 * The caller must be authorized to attach receipts to the expense.
 *
 * Returned intent includes:
 *   - id: intent UUID
 *   - expenseId: parent expense UUID
 *   - expiresAt: ISO timestamp when intent expires
 *   - maxBytes: maximum permitted file size
 *   - allowedTypes: accepted MIME types
 */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!isUuid(id)) return receiptError("Expense not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  const abuse = await enforceAbuseProtection(request, "receipt.upload", clients.wallet);
  if (!abuse.ok) return abuse.response;

  try {
    const access = await loadExpenseAccess(clients.userClient, id);
    if (!access) return receiptError("Expense not found.", 404);

    if (!(await hasExpensePermission(id, "receipts.manage", clients.userClient))) {
      return receiptError("You do not have permission to attach a receipt to this expense.", 403);
    }

    const intent = await createUploadIntent(clients.serviceClient, {
      expenseId: id,
      wallet: clients.wallet,
      idempotencyKey: idempotency.key,
      ttlSeconds: DEFAULT_UPLOAD_INTENT_TTL_SECONDS,
    });

    return receiptJson(
      {
        data: {
          ...intent,
          maxBytes: receiptMaxBytes(),
          allowedTypes: RECEIPT_CONTENT_TYPES,
        },
      },
      201,
    );
  } catch (err) {
    if (err instanceof ReceiptIntentError) {
      return receiptError(err.message, err.status);
    }
    return errorResponse(err);
  }
}
