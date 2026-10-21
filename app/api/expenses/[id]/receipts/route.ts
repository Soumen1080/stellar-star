import type { NextRequest } from "next/server";
import { hasExpensePermission } from "@/lib/supabase/queries";
import { inspectReceiptUpload } from "@/lib/receipts/inspect";
import { receiptMaxBytes } from "@/lib/receipts/policy";
import { listReceipts, loadExpenseAccess, storeReceipt } from "@/lib/receipts/store";
import {
  errorResponse,
  isUuid,
  receiptClients,
  receiptError,
  receiptJson,
} from "@/lib/receipts/http";
import { enforceAbuseProtection } from "@/lib/security/abuseProtection";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** Multipart framing around the file; generous so a limit-sized file is never refused for it. */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

/** Lists the receipts on an expense the caller is a member of. */
export async function GET(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!isUuid(id)) return receiptError("Expense not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  const abuse = await enforceAbuseProtection(request, "receipt.upload", clients.wallet);
  if (!abuse.ok) return abuse.response;

  try {
    const access = await loadExpenseAccess(clients.userClient, id);
    if (!access) return receiptError("Expense not found.", 404);
    return receiptJson({ data: await listReceipts(clients.userClient, id) });
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Attaches a receipt. multipart/form-data with `file` and optional `caption`.
 * Only the payer (or the expense's creator) may attach.
 */
export async function POST(request: NextRequest, context: Context) {
  const { id } = await context.params;
  if (!isUuid(id)) return receiptError("Expense not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  const maxBytes = receiptMaxBytes();
  // Refuse an oversized body before buffering it.
  const declaredLength = Number(request.headers.get("content-length") ?? "0");
  if (declaredLength > maxBytes + MULTIPART_OVERHEAD_BYTES) {
    return receiptError("Receipts must be smaller than the upload limit.", 413);
  }

  try {
    const access = await loadExpenseAccess(clients.userClient, id);
    // Indistinguishable from a missing expense, so ids cannot be probed.
    if (!access) return receiptError("Expense not found.", 404);
    if (!(await hasExpensePermission(id, "receipts.manage", clients.userClient))) {
      return receiptError("You do not have permission to attach a receipt to this expense.", 403);
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return receiptError("Send the receipt as multipart/form-data.", 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return receiptError("Choose a file to upload.", 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const inspected = inspectReceiptUpload({
      bytes,
      declaredType: file.type,
      fileName: "name" in file ? (file as File).name : null,
      caption: form.get("caption"),
      maxBytes,
    });

    const receipt = await storeReceipt(clients.serviceClient, {
      expenseId: id,
      wallet: clients.wallet,
      inspected,
      bytes,
    });
    return receiptJson({ data: receipt }, 201);
  } catch (err) {
    return errorResponse(err);
  }
}
