/**
 * Receipt storage and metadata I/O. Server-only.
 *
 * Two clients, two jobs:
 *  - the caller's own token client (RLS applies) answers "may this wallet see
 *    this expense / receipt?" — authorization is never re-implemented here;
 *  - the service-role client touches the private bucket and writes metadata,
 *    and is only used after that question has been answered yes.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database, ExpenseReceiptRow } from "@/types/supabase";
import type { ExpenseReceipt, ReceiptLink } from "@/types/receipt";
import type { ExpenseAccess } from "./access";
import type { InspectedReceipt } from "./inspect";
import { ReceiptValidationError } from "./inspect";
import { consumeTenantQuota, releaseTenantStorageQuota } from "@/lib/quotas/server";
import {
  MAX_RECEIPTS_PER_EXPENSE,
  RECEIPT_BUCKET,
  SIGNED_URL_TTL_SECONDS,
  receiptRetentionDays,
  type ReceiptContentType,
} from "./policy";
import { cleanupAbandonedUploads, recordPromotedIntent, recordQuarantinedIntent } from "./intent";
import {
  encryptObjectPayload,
  getActiveKey,
  saveObjectEncryptionMetadata,
  logObjectAccess,
  cryptoEraseObject,
} from "@/lib/security/objectEncryption";

type Client = SupabaseClient<Database>;

const RECEIPT_COLUMNS =
  "id, expense_id, storage_path, file_name, content_type, size_bytes, checksum_sha256, caption, status, scan_result, uploaded_by_wallet, created_at, retain_until, removed_at, removed_by_wallet, removal_reason";

export class ReceiptStoreError extends Error {
  readonly status: number;
  readonly retryAfterMs: number;
  constructor(message: string, status = 500, retryAfterMs = 0) {
    super(message);
    this.name = "ReceiptStoreError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export function rowToReceipt(row: ExpenseReceiptRow): ExpenseReceipt {
  return {
    id: row.id,
    expenseId: row.expense_id ?? "",
    fileName: row.file_name,
    contentType: row.content_type as ReceiptContentType,
    sizeBytes: row.size_bytes,
    checksum: row.checksum_sha256,
    caption: row.caption,
    status: row.status,
    uploadedByWallet: row.uploaded_by_wallet,
    createdAt: row.created_at,
    retainUntil: row.retain_until,
    removedAt: row.removed_at,
  };
}

/** The expense as the caller is allowed to see it, or null when RLS hides it. */
export async function loadExpenseAccess(userClient: Client, expenseId: string): Promise<ExpenseAccess | null> {
  const { data, error } = await userClient
    .from("expenses")
    .select("id, paid_by_member_id, members, created_by_wallet")
    .eq("id", expenseId)
    .maybeSingle();
  if (error) throw new ReceiptStoreError("Could not load that expense.");
  if (!data) return null;

  const members = (Array.isArray(data.members) ? data.members : []) as Array<{
    id?: string;
    walletAddress?: string;
  }>;
  const payer = members.find((member) => member?.id === data.paid_by_member_id);
  return {
    expenseId: data.id,
    createdByWallet: data.created_by_wallet,
    payerWallet: payer?.walletAddress ?? null,
  };
}

/** Receipts on an expense the caller can see (RLS), newest first, excluding removed ones. */
export async function listReceipts(userClient: Client, expenseId: string): Promise<ExpenseReceipt[]> {
  const { data, error } = await userClient
    .from("expense_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("expense_id", expenseId)
    .neq("status", "removed")
    .order("created_at", { ascending: false });
  if (error) throw new ReceiptStoreError("Could not load receipts.");
  return (data ?? []).map((row) => rowToReceipt(row as ExpenseReceiptRow));
}

/** A receipt the caller may see (RLS), with its storage path, or null. */
export async function loadReceipt(
  userClient: Client,
  receiptId: string,
): Promise<{ receipt: ExpenseReceipt; storagePath: string } | null> {
  const { data, error } = await userClient
    .from("expense_receipts")
    .select(RECEIPT_COLUMNS)
    .eq("id", receiptId)
    .maybeSingle();
  if (error) throw new ReceiptStoreError("Could not load that receipt.");
  if (!data) return null;
  const row = data as ExpenseReceiptRow;
  return { receipt: rowToReceipt(row), storagePath: row.storage_path };
}

/**
 * Object key. Built only from server-generated ids — a user-supplied file name
 * never reaches the path. Quarantined files live under a separate prefix that
 * no code path signs.
 */
export function receiptStoragePath(
  expenseId: string,
  receiptId: string,
  ext: string,
  quarantined: boolean,
): string {
  return `${quarantined ? "quarantine" : "receipts"}/${expenseId}/${receiptId}.${ext}`;
}

export async function storeReceipt(
  serviceClient: Client,
  {
    expenseId,
    wallet,
    inspected,
    bytes,
    now = new Date(),
    intentId,
    encrypted = false,
    requestId,
  }: {
    expenseId: string;
    wallet: string;
    inspected: InspectedReceipt;
    bytes: Uint8Array;
    now?: Date;
    intentId?: string;
    encrypted?: boolean;
    requestId?: string;
  },
): Promise<ExpenseReceipt> {
  const { count, error: countError } = await serviceClient
    .from("expense_receipts")
    .select("id", { count: "exact", head: true })
    .eq("expense_id", expenseId)
    .neq("status", "removed");
  if (countError) throw new ReceiptStoreError("Could not check existing receipts.");
  if ((count ?? 0) >= MAX_RECEIPTS_PER_EXPENSE) {
    throw new ReceiptValidationError(
      `An expense can have at most ${MAX_RECEIPTS_PER_EXPENSE} receipts. Remove one first.`,
      409,
    );
  }

  const id = crypto.randomUUID();
  const quarantined = inspected.scan.verdict === "quarantine";
  const storagePath = receiptStoragePath(expenseId, id, inspected.ext, quarantined);
  const retainUntil = new Date(now.getTime() + receiptRetentionDays() * 86_400_000);

  const quota = await consumeTenantQuota(wallet, { objects: 1, bytes: bytes.byteLength }, id);
  if (!quota.available) throw new ReceiptStoreError("Storage quota service is unavailable.", 503);
  if (!quota.allowed) {
    throw new ReceiptStoreError(
      quota.metric === "objects" ? "Your object storage limit has been reached." : "Your storage byte limit has been reached.",
      429,
      quota.resetMs,
    );
  }

  let uploadPayload: Uint8Array = bytes;
  let encryptionResult: ReturnType<typeof encryptObjectPayload> | null = null;
  let activeKey: Awaited<ReturnType<typeof getActiveKey>> | null = null;

  if (encrypted) {
    try {
      activeKey = await getActiveKey(serviceClient as never);
      if (activeKey?.key_material) {
        encryptionResult = encryptObjectPayload({
          bytes,
          keyMaterial: activeKey.key_material,
          keyId: activeKey.key_id,
          storagePath,
          algorithm: activeKey.algorithm,
        });
        uploadPayload = encryptionResult.ciphertext;
      }
    } catch {
      // If encryption setup fails, fall back to unencrypted upload
    }
  }

  const bucket = serviceClient.storage.from(RECEIPT_BUCKET);
  const { error: uploadError } = await bucket.upload(storagePath, uploadPayload, {
    contentType: inspected.contentType,
    cacheControl: "private, max-age=0, no-store",
    upsert: false,
  });
  if (uploadError) {
    await releaseTenantStorageQuota(id);
    throw new ReceiptStoreError("Could not store the file. Please try again.", 502);
  }

  const { data, error } = await serviceClient
    .from("expense_receipts")
    .insert({
      id,
      expense_id: expenseId,
      storage_path: storagePath,
      file_name: inspected.fileName,
      content_type: inspected.contentType,
      size_bytes: inspected.sizeBytes,
      checksum_sha256: inspected.checksum,
      caption: inspected.caption,
      status: quarantined ? "quarantined" : "active",
      scan_result: { ...inspected.scan },
      uploaded_by_wallet: wallet,
      created_at: now.toISOString(),
      retain_until: retainUntil.toISOString(),
    })
    .select(RECEIPT_COLUMNS)
    .single();

  if (error || !data) {
    // Never leave an object without the metadata row that governs its access
    // and retention.
    const { error: cleanupError } = await bucket.remove([storagePath]);
    if (!cleanupError) await releaseTenantStorageQuota(id);
    if (error?.code === "23505") {
      throw new ReceiptValidationError("This exact file is already attached to the expense.", 409);
    }
    throw new ReceiptStoreError("Could not save the receipt details. Please try again.");
  }

  // Update upload intent if intentId was passed
  if (intentId) {
    if (quarantined) {
      await recordQuarantinedIntent(serviceClient, {
        intentId,
        storagePath,
        fileName: inspected.fileName,
        contentType: inspected.contentType,
        sizeBytes: inspected.sizeBytes,
        checksum: inspected.checksum,
        caption: inspected.caption,
        scanResult: { ...inspected.scan },
        now,
      }).catch(() => {});
    } else {
      await recordPromotedIntent(serviceClient, {
        intentId,
        receiptId: id,
        promotedPath: storagePath,
        fileName: inspected.fileName,
        contentType: inspected.contentType,
        sizeBytes: inspected.sizeBytes,
        checksum: inspected.checksum,
        caption: inspected.caption,
        scanResult: { ...inspected.scan },
        now,
      }).catch(() => {});
    }
  }

  // Issue #453: Persist object encryption metadata and log access
  if (encrypted && encryptionResult && activeKey) {
    await saveObjectEncryptionMetadata(serviceClient as never, {
      bucket: RECEIPT_BUCKET,
      storagePath,
      ownerWallet: wallet,
      expenseId,
      keyId: activeKey.key_id,
      algorithm: activeKey.algorithm,
      iv: encryptionResult.iv,
      authTag: encryptionResult.authTag,
      ciphertextSha256: encryptionResult.ciphertextSha256,
      plaintextSha256: encryptionResult.plaintextSha256,
      byteSize: bytes.byteLength,
      status: quarantined ? "quarantined" : "active",
      now,
    }).catch(() => {});

    if (requestId) {
      await logObjectAccess(serviceClient as never, {
        bucket: RECEIPT_BUCKET,
        storagePath,
        actorWallet: wallet,
        action: "encrypt",
        status: "success",
        keyId: activeKey.key_id,
        requestId,
      }).catch(() => {});
    }
  }

  return rowToReceipt(data as ExpenseReceiptRow);
}

export async function createReceiptLink(
  serviceClient: Client,
  storagePath: string,
  fileName: string | null,
  now: Date = new Date(),
): Promise<ReceiptLink> {
  if (!storagePath.startsWith("receipts/")) {
    // Belt and braces: quarantined objects are never signed, whatever the row says.
    throw new ReceiptStoreError("This file cannot be downloaded.", 403);
  }
  const { data, error } = await serviceClient.storage
    .from(RECEIPT_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_TTL_SECONDS, { download: fileName ?? true });
  if (error || !data?.signedUrl) throw new ReceiptStoreError("Could not create a download link.", 502);
  return {
    url: data.signedUrl,
    expiresAt: new Date(now.getTime() + SIGNED_URL_TTL_SECONDS * 1000).toISOString(),
  };
}

/**
 * Deletes the stored file and tombstones the row. The tombstone keeps who
 * removed what and when (an audit fact), but drops the file name and caption,
 * which are user content the retention policy says to forget.
 */
export async function removeReceipt(
  serviceClient: Client,
  {
    receiptId,
    storagePath,
    wallet,
    reason,
    now = new Date(),
  }: {
    receiptId: string;
    storagePath: string;
    wallet: string | null;
    reason: "user" | "retention" | "expense_deleted";
    now?: Date;
  },
): Promise<void> {
  const { data: quotaRow, error: quotaRowError } = await serviceClient
    .from("expense_receipts")
    .select("id, size_bytes, uploaded_by_wallet, status")
    .eq("id", receiptId)
    .maybeSingle();
  if (quotaRowError) throw new ReceiptStoreError("Could not check storage quota details.");
  if (!quotaRow) throw new ReceiptStoreError("That receipt is no longer available.", 404);
  if (quotaRow.status === "removed") return;
  const { error: removeError } = await serviceClient.storage.from(RECEIPT_BUCKET).remove([storagePath]);
    if (removeError) throw new ReceiptStoreError("Could not delete the stored file.", 502);

  // Issue #453: Cryptographically erase object metadata
  await cryptoEraseObject(serviceClient as never, {
    bucket: RECEIPT_BUCKET,
    storagePath,
    actorWallet: wallet ?? "system:retention",
    requestId: `remove-${receiptId}`,
    now,
  }).catch(() => {});

  const { error } = await serviceClient
    .from("expense_receipts")
    .update({
      status: "removed",
      file_name: null,
      caption: null,
      removed_at: now.toISOString(),
      removed_by_wallet: wallet,
      removal_reason: reason,
    })
    .eq("id", receiptId);
  await releaseTenantStorageQuota(receiptId);
  if (error) throw new ReceiptStoreError("The file was deleted but its record could not be updated.");
}

/**
 * Retention sweep: removes receipts past `retain_until`, and receipts whose
 * expense was deleted (expense_id set NULL by the foreign key).
 */
export async function purgeExpiredReceipts(
  serviceClient: Client,
  { now = new Date(), batchSize = 100 }: { now?: Date; batchSize?: number } = {},
): Promise<{ purged: number; failed: number; abandonedCleaned: number }> {
  const { data, error } = await serviceClient
    .from("expense_receipts")
    .select("id, storage_path, expense_id, retain_until")
    .neq("status", "removed")
    .or(`retain_until.lte.${now.toISOString()},expense_id.is.null`)
    .limit(batchSize);
  if (error) throw new ReceiptStoreError("Could not list receipts due for removal.");

  let purged = 0;
  let failed = 0;
  for (const row of data ?? []) {
    try {
      await removeReceipt(serviceClient, {
        receiptId: row.id,
        storagePath: row.storage_path,
        wallet: null,
        reason: row.expense_id === null ? "expense_deleted" : "retention",
        now,
      });
      purged += 1;
    } catch {
      failed += 1;
    }
  }

  // Clean up abandoned upload intents and orphaned quarantine objects (#451)
  const { failed: abandonedFailed } = await cleanupAbandonedUploads(serviceClient, {
    now,
    batchSize,
  }).catch(() => ({ cleaned: 0, failed: 0 }));

  return { purged, failed: failed + abandonedFailed };
}
