"use client";

import { listExpenseReceipts, ReceiptRequestError, uploadExpenseReceipt } from "@/lib/receipts/client";

/** A conflict alone is not proof of upload: quota conflicts also return 409. */
export async function attachReceiptOriginal(expenseId: string, file: File) {
  try {
    return await uploadExpenseReceipt(expenseId, file, file.name, "");
  } catch (error) {
    if (!(error instanceof ReceiptRequestError) || error.status !== 409) throw error;
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    const checksum = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    const receipts = await listExpenseReceipts(expenseId);
    const existing = receipts.find((receipt) => receipt.checksum === checksum && receipt.status !== "removed");
    if (!existing) throw error;
    return existing;
  }
}
