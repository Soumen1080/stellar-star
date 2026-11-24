import { createHash } from "crypto";
import type { NextRequest } from "next/server";
import { hasExpensePermission } from "@/lib/supabase/queries";
import { inspectReceiptUpload } from "@/lib/receipts/inspect";
import { receiptMaxBytes } from "@/lib/receipts/policy";
import { RequestBodyError, readLimitedFormData } from "@/lib/api/bodyLimits";
import { listReceipts, loadExpenseAccess, storeReceipt } from "@/lib/receipts/store";
import {
  errorResponse,
  isUuid,
  RECEIPT_RESPONSE_HEADERS,
  receiptClients,
  receiptError,
  receiptJson,
} from "@/lib/receipts/http";
import { enforceAbuseProtection } from "@/lib/security/abuseProtection";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { RECEIPT_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";

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

  // Issue #412: a valid key is required before the upload is read.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

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

    // Counted as it streams, so a lying or absent Content-Length cannot make
    // formData() buffer an unbounded body (#418).
    let form: FormData;
    try {
      form = await readLimitedFormData(request, maxBytes + MULTIPART_OVERHEAD_BYTES);
    } catch (err) {
      if (err instanceof RequestBodyError && err.status === 413) {
        return receiptError("Receipts must be smaller than the upload limit.", 413);
      }
      if (err instanceof RequestBodyError && err.status === 415) {
        return receiptError("Send the receipt as multipart/form-data.", 415);
      }
      return receiptError("Send the receipt as multipart/form-data.", 400);
    }
    const file = form.get("file");
    if (!file || typeof file === "string") return receiptError("Choose a file to upload.", 400);

    const bytes = new Uint8Array(await file.arrayBuffer());
    const fileName = "name" in file ? (file as File).name : null;
    const caption = form.get("caption");
    const intentId = form.get("intent_id")?.toString();
    const inspected = inspectReceiptUpload({
      bytes,
      declaredType: file.type,
      fileName,
      caption,
      maxBytes,
    });

    // The same bytes, name and caption under the same key are the same upload;
    // a retry replays the stored receipt instead of storing a second copy.
    return await runIdempotentMutation({
      request,
      client: clients.userClient,
      key: idempotency.key,
      replayFields: replayFieldsUnder("data", RECEIPT_REPLAY_FIELDS),
      principal: clients.wallet,
      payload: {
        sha256: createHash("sha256").update(bytes).digest("hex"),
        fileName,
        declaredType: file.type,
        caption: typeof caption === "string" ? caption : null,
      },
      leaseSeconds: 120,
      replayHeaders: { ...RECEIPT_RESPONSE_HEADERS },
      execute: async () => {
        const receipt = await storeReceipt(clients.serviceClient, {
          expenseId: id,
          wallet: clients.wallet,
          inspected,
          bytes,
          intentId: intentId ?? undefined,
        });
        return receiptJson({ data: receipt }, 201);
      },
    });
  } catch (err) {
    return errorResponse(err);
  }
}
