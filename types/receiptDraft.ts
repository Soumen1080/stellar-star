export interface ReceiptSuggestion {
  value: string;
  confidence: number;
  reviewed: boolean;
}

export const RECEIPT_FIELDS = ["merchant", "date", "total", "currency"] as const;
export type ReceiptField = typeof RECEIPT_FIELDS[number];
export interface ReceiptLineItem {
  id: string;
  description: ReceiptSuggestion;
  amount: ReceiptSuggestion;
}
export interface ReceiptDraft {
  fields: Record<ReceiptField, ReceiptSuggestion>;
  lineItems: ReceiptLineItem[];
  lineItemsReviewed: boolean;
}
export const LOW_CONFIDENCE_THRESHOLD = 85;

export function suggestion(value = "", confidence = 0): ReceiptSuggestion {
  return { value, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) : 0, reviewed: false };
}
