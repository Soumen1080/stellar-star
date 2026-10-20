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
