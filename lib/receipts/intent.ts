/**
 * lib/receipts/intent.ts
 *
 * Short-lived upload intent management and abandoned upload cleanup (issue #451).
 *
 * Guarantees:
 *  1. An upload intent is created before or during the upload pipeline.
 *  2. Upload intents are short-lived (default 15 minutes / 900 seconds).
 *  3. Unfinished or abandoned uploads that exceed the TTL are swept and
 *     any orphaned quarantine objects in storage are deleted.
 *  4. Client metadata cannot bypass verification: the intent status transitions
 *     from `pending` to `quarantined` (if flagged) or `promoted` (if clean).
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ReceiptUploadIntentRow } from "@/types/supabase";
import type { ReceiptUploadIntent, UploadIntentStatus } from "@/types/receipt";
import { RECEIPT_BUCKET } from "./policy";

type Client = SupabaseClient<Database>;

export const DEFAULT_UPLOAD_INTENT_TTL_SECONDS = 900; // 15 minutes

export class ReceiptIntentError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "ReceiptIntentError";
    this.status = status;
  }
}

export function rowToUploadIntent(row: ReceiptUploadIntentRow): ReceiptUploadIntent {
  return {
    id: row.id,
    expenseId: row.expense_id,
    wallet: row.wallet,
    idempotencyKey: row.idempotency_key,
    status: row.status as UploadIntentStatus,
    fileName: row.file_name,
    contentType: row.content_type,
    sizeBytes: row.size_bytes,
    checksum: row.checksum_sha256,
    caption: row.caption,
    storagePath: row.storage_path,
    promotedPath: row.promoted_path,
    scanResult: (row.scan_result ?? {}) as Record<string, unknown>,
    receiptId: row.receipt_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Creates a short-lived receipt upload intent.
 */
export async function createUploadIntent(
  serviceClient: Client,
  {
    expenseId,
    wallet,
    idempotencyKey,
    ttlSeconds = DEFAULT_UPLOAD_INTENT_TTL_SECONDS,
    now = new Date(),
  }: {
    expenseId: string;
    wallet: string;
    idempotencyKey: string;
    ttlSeconds?: number;
    now?: Date;
  },
): Promise<ReceiptUploadIntent> {
  const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);

  // Check if an intent with this idempotency key already exists
  const { data: existing, error: existingError } = await serviceClient
    .from("receipt_upload_intents")
    .select("*")
    .eq("idempotency_key", idempotencyKey)
    .maybeSingle();

  if (existingError) {
    throw new ReceiptIntentError("Could not check existing upload intent.");
  }

  if (existing) {
    if (existing.wallet !== wallet || existing.expense_id !== expenseId) {
      throw new ReceiptIntentError("Idempotency key conflict for upload intent.", 409);
    }
    return rowToUploadIntent(existing as ReceiptUploadIntentRow);
  }

  const { data, error } = await serviceClient
    .from("receipt_upload_intents")
    .insert({
      expense_id: expenseId,
      wallet,
      idempotency_key: idempotencyKey,
      status: "pending",
      expires_at: expiresAt.toISOString(),
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new ReceiptIntentError("Could not create upload intent.");
  }

  return rowToUploadIntent(data as ReceiptUploadIntentRow);
}

/**
 * Loads an upload intent by ID.
 */
export async function loadUploadIntent(
  client: Client,
  intentId: string,
): Promise<ReceiptUploadIntent | null> {
  const { data, error } = await client
    .from("receipt_upload_intents")
    .select("*")
    .eq("id", intentId)
    .maybeSingle();

  if (error) throw new ReceiptIntentError("Could not load upload intent.");
  if (!data) return null;
  return rowToUploadIntent(data as ReceiptUploadIntentRow);
}

/**
 * Transitions an upload intent to quarantined status.
 */
export async function recordQuarantinedIntent(
  serviceClient: Client,
  {
    intentId,
    storagePath,
    fileName,
    contentType,
    sizeBytes,
    checksum,
    caption,
    scanResult,
    now = new Date(),
  }: {
    intentId: string;
    storagePath: string;
    fileName: string | null;
    contentType: string;
    sizeBytes: number;
    checksum: string;
    caption: string | null;
    scanResult: Record<string, unknown>;
    now?: Date;
  },
): Promise<ReceiptUploadIntent> {
  const { data, error } = await serviceClient
    .from("receipt_upload_intents")
    .update({
      status: "quarantined",
      storage_path: storagePath,
      file_name: fileName,
      content_type: contentType,
      size_bytes: sizeBytes,
      checksum_sha256: checksum,
      caption,
      scan_result: scanResult,
      updated_at: now.toISOString(),
    })
    .eq("id", intentId)
    .select("*")
    .single();

  if (error || !data) throw new ReceiptIntentError("Could not record quarantined upload intent.");
  return rowToUploadIntent(data as ReceiptUploadIntentRow);
}

/**
 * Transitions an upload intent to promoted status.
 */
export async function recordPromotedIntent(
  serviceClient: Client,
  {
    intentId,
    receiptId,
    promotedPath,
    fileName,
    contentType,
    sizeBytes,
    checksum,
    caption,
    scanResult,
    now = new Date(),
  }: {
    intentId: string;
    receiptId: string;
    promotedPath: string;
    fileName: string | null;
    contentType: string;
    sizeBytes: number;
    checksum: string;
    caption: string | null;
    scanResult: Record<string, unknown>;
    now?: Date;
  },
): Promise<ReceiptUploadIntent> {
  const { data, error } = await serviceClient
    .from("receipt_upload_intents")
    .update({
      status: "promoted",
      receipt_id: receiptId,
      promoted_path: promotedPath,
      file_name: fileName,
      content_type: contentType,
      size_bytes: sizeBytes,
      checksum_sha256: checksum,
      caption,
      scan_result: scanResult,
      updated_at: now.toISOString(),
    })
    .eq("id", intentId)
    .select("*")
    .single();

  if (error || !data) throw new ReceiptIntentError("Could not record promoted upload intent.");
  return rowToUploadIntent(data as ReceiptUploadIntentRow);
}

/**
 * Sweeps expired upload intents and deletes any abandoned staged files in quarantine storage.
 */
export async function cleanupAbandonedUploads(
  serviceClient: Client,
  { now = new Date(), batchSize = 100 }: { now?: Date; batchSize?: number } = {},
): Promise<{ cleaned: number; failed: number }> {
  const { data, error } = await serviceClient
    .from("receipt_upload_intents")
    .select("id, storage_path, status, expires_at")
    .in("status", ["pending", "quarantined"])
    .lte("expires_at", now.toISOString())
    .limit(batchSize);

  if (error) throw new ReceiptIntentError("Could not list expired upload intents.");

  let cleaned = 0;
  let failed = 0;

  for (const row of data ?? []) {
    try {
      // If a quarantine storage path was written, clean up the object
      if (row.storage_path && row.storage_path.startsWith("quarantine/")) {
        const { error: removeError } = await serviceClient.storage
          .from(RECEIPT_BUCKET)
          .remove([row.storage_path]);
        if (removeError) {
          failed += 1;
          continue;
        }
      }

      const { error: updateError } = await serviceClient
        .from("receipt_upload_intents")
        .update({
          status: "abandoned",
          updated_at: now.toISOString(),
        })
        .eq("id", row.id);

      if (updateError) {
        failed += 1;
      } else {
        cleaned += 1;
      }
    } catch {
      failed += 1;
    }
  }

  return { cleaned, failed };
}
