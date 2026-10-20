/**
 * Who may do what with a receipt. Pure decisions; the routes supply the facts.
 *
 * Seeing an expense at all is decided upstream by RLS (`member_wallets`): an
 * expense the caller cannot read is reported as "not found", never "forbidden",
 * so receipt routes do not reveal which expense ids exist.
 */

import type { ExpenseReceipt } from "@/types/receipt";

export interface ExpenseAccess {
  expenseId: string;
  createdByWallet: string;
  /** Wallet of the member recorded as having paid, when they have one. */
  payerWallet: string | null;
}

function sameWallet(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.trim().toUpperCase() === b.trim().toUpperCase();
}

/** The payer attaches the bill; the expense creator may too (they often entered it for the payer). */
export function canUploadReceipt(access: ExpenseAccess, wallet: string): boolean {
  return sameWallet(access.payerWallet, wallet) || sameWallet(access.createdByWallet, wallet);
}

/** The uploader can always take their file back; the expense creator can clean up the expense. */
export function canRemoveReceipt(
  receipt: Pick<ExpenseReceipt, "uploadedByWallet">,
  access: ExpenseAccess | null,
  wallet: string,
): boolean {
  return sameWallet(receipt.uploadedByWallet, wallet) || sameWallet(access?.createdByWallet, wallet);
}

export type ViewDecision = { ok: true } | { ok: false; status: number; message: string };

/** Whether a (visible) receipt may be handed a download link. */
export function receiptViewDecision(receipt: Pick<ExpenseReceipt, "status">): ViewDecision {
  if (receipt.status === "quarantined") {
    return {
      ok: false,
      status: 403,
      message: "This file was held back by the safety scan and cannot be downloaded.",
    };
  }
  if (receipt.status === "removed") {
    return { ok: false, status: 410, message: "This receipt has been removed." };
  }
  return { ok: true };
}
