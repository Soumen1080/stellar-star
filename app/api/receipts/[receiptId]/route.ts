import type { NextRequest } from "next/server";
import { canRemoveReceipt, receiptViewDecision } from "@/lib/receipts/access";
import {
  createReceiptLink,
  loadExpenseAccess,
  loadReceipt,
  removeReceipt,
} from "@/lib/receipts/store";
import {
  errorResponse,
  isUuid,
  receiptClients,
  receiptError,
  receiptJson,
} from "@/lib/receipts/http";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ receiptId: string }> };

/**
 * Issues a short-lived signed download link. Membership is checked on every
 * request (the receipt row is read with the caller's own RLS-bound client), so
 * a member removed from the expense loses access at their next click, and a
 * leaked link stops working within SIGNED_URL_TTL_SECONDS.
 */
export async function GET(request: NextRequest, context: Context) {
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Receipt not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  try {
    const found = await loadReceipt(clients.userClient, receiptId);
    if (!found) return receiptError("Receipt not found.", 404);

    const decision = receiptViewDecision(found.receipt);
    if (!decision.ok) return receiptError(decision.message, decision.status);

    const link = await createReceiptLink(clients.serviceClient, found.storagePath, found.receipt.fileName);
    return receiptJson({ data: link });
  } catch (err) {
    return errorResponse(err);
  }
}

/** Removes a receipt: deletes the file and keeps an audit tombstone. */
export async function DELETE(request: NextRequest, context: Context) {
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Receipt not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  try {
    const found = await loadReceipt(clients.userClient, receiptId);
    if (!found) return receiptError("Receipt not found.", 404);
    if (found.receipt.status === "removed") return receiptJson({ data: { removed: true } });

    const access = found.receipt.expenseId
      ? await loadExpenseAccess(clients.userClient, found.receipt.expenseId)
      : null;
    if (!canRemoveReceipt(found.receipt, access, clients.wallet)) {
      return receiptError("Only the uploader or the expense creator can remove this receipt.", 403);
    }

    await removeReceipt(clients.serviceClient, {
      receiptId,
      storagePath: found.storagePath,
      wallet: clients.wallet,
      reason: "user",
    });
    return receiptJson({ data: { removed: true } });
  } catch (err) {
    return errorResponse(err);
  }
}
