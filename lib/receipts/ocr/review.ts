import { RECEIPT_FIELDS, type ReceiptDraft } from "@/types/receiptDraft";
import { positiveReceiptAmount, receiptAmount } from "./amount";
import { receiptDate } from "./date";
import { RECEIPT_CURRENCIES } from "./parser";

export function canUseReceiptDraft(draft: ReceiptDraft): boolean {
  return RECEIPT_FIELDS.every((field) => draft.fields[field].reviewed)
    && !!draft.fields.merchant.value.trim()
    && draft.fields.merchant.value.length <= 200
    && receiptDate(draft.fields.date.value) !== null
    && positiveReceiptAmount(draft.fields.total.value)
    && RECEIPT_CURRENCIES.some((currency) => currency === draft.fields.currency.value)
    && draft.lineItemsReviewed
    && draft.lineItems.every((line) => line.description.reviewed && line.amount.reviewed
      && !!line.description.value.trim() && line.description.value.length <= 200
      && receiptAmount(line.amount.value) !== null);
}

/** Reviewed details remain ordinary private expense text, never payment instructions. */
export function receiptDraftDescription(draft: ReceiptDraft): string {
  return [`Receipt date: ${draft.fields.date.value}`, ...draft.lineItems.map((line) =>
    `${line.description.value}: ${line.amount.value} ${draft.fields.currency.value}`)].join("\n");
}
