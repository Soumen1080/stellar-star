/**
 * app/api/receipts/[receiptId]/metadata/route.ts
 *
 * Issue #453: Read private object encryption metadata with strict authorization.
 * Unauthorized metadata reads fail closed with 403.
 * Logs access correlating request ID.
 */

import { NextRequest, NextResponse } from "next/server";
import { receiptClients, receiptError, receiptJson, isUuid } from "@/lib/receipts/http";
import { loadReceipt } from "@/lib/receipts/store";
import { loadObjectEncryptionMetadata, logObjectAccess } from "@/lib/security/objectEncryption";
import { RECEIPT_BUCKET } from "@/lib/receipts/policy";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ receiptId: string }> };

export async function GET(request: NextRequest, context: Context) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const { receiptId } = await context.params;
  if (!isUuid(receiptId)) return receiptError("Receipt not found.", 404);

  const clients = receiptClients(request);
  if ("response" in clients) return clients.response;

  // Load receipt using RLS client to verify permission
  const loaded = await loadReceipt(clients.userClient, receiptId);
  if (!loaded) {
    // Log unauthorized or non-existent metadata access attempt
    await logObjectAccess(clients.serviceClient, {
      bucket: RECEIPT_BUCKET,
      storagePath: `receipts/${receiptId}`,
      actorWallet: clients.wallet,
      action: "read_metadata",
      status: "forbidden",
      requestId,
      errorMessage: "Caller is not authorized to read object metadata.",
    }).catch(() => {});

    return NextResponse.json(
      { error: "Receipt not found or permission denied.", code: "FORBIDDEN" },
      { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  // Load encryption metadata
  const meta = await loadObjectEncryptionMetadata(clients.userClient, loaded.storagePath);

  await logObjectAccess(clients.serviceClient, {
    bucket: RECEIPT_BUCKET,
    storagePath: loaded.storagePath,
    actorWallet: clients.wallet,
    action: "read_metadata",
    status: meta ? "success" : "failed",
    keyId: meta?.key_id ?? null,
    requestId,
  }).catch(() => {});

  if (!meta) {
    return NextResponse.json(
      {
        data: {
          receiptId,
          storagePath: loaded.storagePath,
          status: loaded.receipt.status,
          encrypted: false,
        },
        requestId,
      },
      { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
    );
  }

  return NextResponse.json(
    {
      data: {
        receiptId,
        storagePath: meta.storage_path,
        keyId: meta.key_id,
        algorithm: meta.algorithm,
        byteSize: meta.byte_size,
        status: meta.status,
        ciphertextSha256: meta.ciphertext_sha256,
        lastRotatedAt: meta.last_rotated_at,
        createdAt: meta.created_at,
      },
      requestId,
    },
    { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
