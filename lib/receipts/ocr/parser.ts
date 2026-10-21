import { suggestion, type ReceiptDraft } from "@/types/receiptDraft";
import { receiptAmount } from "./amount";
import { receiptDate } from "./date";
import { SUPPORTED_CRYPTO, SUPPORTED_FIAT } from "@/lib/fx/currencies";

export const MAX_OCR_LINES = 100;
export const MAX_LINE_ITEMS = 40;
export const RECEIPT_CURRENCIES = [...SUPPORTED_CRYPTO, ...SUPPORTED_FIAT];
const SUMMARY = /\b(total|subtotal|tax|vat|change|cash|card|balance|discount|tip|paid|tender|rounding)\b/i;

/** Deliberately conservative receipt heuristics over untrusted OCR text. */
export function parseReceiptText(text: string, confidence: number): ReceiptDraft {
  const lines = text.slice(0, 20000).split(/\r?\n/).map((line) => line.trim().slice(0, 200))
    .filter(Boolean).slice(0, MAX_OCR_LINES);
  const totals = lines.filter((line) => /^(?:grand\s+total|total|amount\s+due)\s*[: ]/i.test(line))
    .map((line) => receiptAmount(line.match(/(\d[\d.,]*)\s*(?:[A-Z]{3})?$/)?.[1] ?? ""))
    .filter((value): value is string => value !== null);
  const dates = [...new Set(lines.flatMap((line) => line.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? []))]
    .filter((date) => receiptDate(date) !== null);
  // A currency symbol alone is ambiguous (e.g. USD/CAD/AUD all use $).
  const currencies = [...new Set((lines.join(" ").match(/\b[A-Z]{3}\b/g) ?? [])
    .filter((code) => RECEIPT_CURRENCIES.some((supported) => supported === code)))];
  const merchant = lines[0] && !SUMMARY.test(lines[0]) && !/\d{4}-\d{2}-\d{2}/.test(lines[0])
    ? lines[0] : "";
  const lineItems = lines.slice(1).flatMap((line, index) => {
    if (SUMMARY.test(line) || /\b\d{4}-\d{2}-\d{2}\b/.test(line)) return [];
    const match = line.match(/^(.+?)\s+(\d+(?:\.\d{1,7})?)$/);
    if (!match || !receiptAmount(match[2])) return [];
    return [{ id: `ocr-${index}`, description: suggestion(match[1], Math.min(confidence, 75)),
      amount: suggestion(match[2], Math.min(confidence, 75)) }];
  }).slice(0, MAX_LINE_ITEMS);
  return {
    fields: {
      merchant: suggestion(merchant, Math.min(confidence, 75)),
      date: suggestion(dates.length === 1 ? dates[0] : "", confidence),
      total: suggestion(totals.length === 1 ? totals[0] : "", confidence),
      currency: suggestion(currencies.length === 1 ? currencies[0] : "", confidence),
    },
    lineItems,
    lineItemsReviewed: false,
  };
}
