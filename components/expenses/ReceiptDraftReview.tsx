"use client";

import { RECEIPT_FIELDS, type ReceiptDraft } from "@/types/receiptDraft";
import { canUseReceiptDraft } from "@/lib/receipts/ocr/review";
import { RECEIPT_CURRENCIES } from "@/lib/receipts/ocr/parser";
import { ReceiptDraftField } from "./ReceiptDraftField";
import { ReceiptDraftLines } from "./ReceiptDraftLines";

export function ReceiptDraftReview({ draft, onChange, onUse }: {
  draft: ReceiptDraft; onChange: (draft: ReceiptDraft) => void; onUse: () => void;
}) {
  return <div className="space-y-4">
    <p className="text-sm font-semibold">Check every field against the original. OCR can be wrong.</p>
    {RECEIPT_FIELDS.map((key) => <ReceiptDraftField key={key} label={`Receipt ${key}`} field={draft.fields[key]}
      type={key === "date" ? "date" : key === "total" ? "number" : "text"}
      options={key === "currency" ? RECEIPT_CURRENCIES : undefined}
      onChange={(field) => onChange({ ...draft, fields: { ...draft.fields, [key]: field } })} />)}
    <p className="text-sm">Missing or ambiguous fields require manual entry. Enter a positive total exactly as printed;
      no total is inferred from items. Use YYYY-MM-DD for the date.</p>
    <ReceiptDraftLines draft={draft} onChange={onChange} />
    <button type="button" disabled={!canUseReceiptDraft(draft)} onClick={onUse}
      className="rounded bg-[#0F0F14] px-4 py-2 text-white disabled:opacity-50">Use reviewed receipt draft</button>
  </div>;
}
