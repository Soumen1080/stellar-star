import type { NextRequest } from "next/server";
import { receiptClients, receiptError, receiptJson } from "@/lib/receipts/http";
import { RECEIPT_BUCKET, receiptMaxBytes } from "@/lib/receipts/policy";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Check storage before creating a receipt-assisted expense, without uploading a draft. */
export async function GET(request: NextRequest) {
  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;
  try {
    const { data: bucket, error } = await clients.serviceClient.storage.getBucket(RECEIPT_BUCKET);
    const { error: schemaError } = await clients.serviceClient.from("expense_receipts").select("id").limit(1);
    if (error || schemaError || !bucket || bucket.public) {
      return receiptError("Private receipt storage is not ready. Your expense has not been created.", 503);
    }
    const bucketLimit = Number(bucket.file_size_limit);
    const maxBytes = Number.isFinite(bucketLimit) && bucketLimit > 0
      ? Math.min(receiptMaxBytes(), bucketLimit) : receiptMaxBytes();
    return receiptJson({ data: { maxBytes } });
  } catch {
    return receiptError("Receipt storage could not be checked. Your expense has not been created.", 503);
  }
}
