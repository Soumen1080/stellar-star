import type { ReceiptContentType } from "@/lib/receipts/policy";

export type ReceiptStatus = "active" | "quarantined" | "removed";

/** Receipt metadata as clients see it. The storage path is deliberately absent. */
export interface ExpenseReceipt {
  id: string;
  expenseId: string;
  fileName: string | null;
  contentType: ReceiptContentType;
  sizeBytes: number;
  /** SHA-256 of the stored bytes, hex. Lets anyone verify a download is the original. */
  checksum: string;
  caption: string | null;
  status: ReceiptStatus;
  uploadedByWallet: string;
  createdAt: string;
  retainUntil: string;
  removedAt: string | null;
}

export interface ReceiptLink {
  url: string;
  /** ISO timestamp after which the signed URL stops working. */
  expiresAt: string;
}

/** Status of a short-lived upload intent (issue #451). */
export type UploadIntentStatus = "pending" | "quarantined" | "promoted" | "rejected" | "abandoned";

/** Short-lived upload intent metadata. */
export interface ReceiptUploadIntent {
  id: string;
  expenseId: string;
  wallet: string;
  idempotencyKey: string;
  status: UploadIntentStatus;
  fileName: string | null;
  contentType: string | null;
  sizeBytes: number | null;
  checksum: string | null;
  caption: string | null;
  storagePath: string | null;
  promotedPath: string | null;
  scanResult: Record<string, unknown>;
  receiptId: string | null;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
}
