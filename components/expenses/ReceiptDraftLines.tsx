"use client";

import { suggestion, type ReceiptDraft } from "@/types/receiptDraft";
import { MAX_LINE_ITEMS } from "@/lib/receipts/ocr/parser";
import { ReceiptDraftField } from "./ReceiptDraftField";

export function ReceiptDraftLines({ draft, onChange }: { draft: ReceiptDraft; onChange: (draft: ReceiptDraft) => void }) {
  return <fieldset className="space-y-3 rounded border p-3">
    <legend className="font-semibold">Line items</legend>
    <p className="text-sm">Add missing items or remove incorrect suggestions. Items never calculate the total.</p>
    {draft.lineItems.map((line, index) => <div key={line.id} className="space-y-2 rounded border p-3">
      {(["description", "amount"] as const).map((key) => <ReceiptDraftField key={key}
        label={`Item ${index + 1} ${key}`} field={line[key]} type={key === "amount" ? "number" : "text"}
        onChange={(value) => onChange({ ...draft, lineItemsReviewed: false,
          lineItems: draft.lineItems.map((item) => item.id === line.id ? { ...item, [key]: value } : item) })} />)}
      <button type="button" onClick={() => onChange({ ...draft, lineItemsReviewed: false,
        lineItems: draft.lineItems.filter((item) => item.id !== line.id) })}>Remove item {index + 1}</button>
    </div>)}
    <button type="button" disabled={draft.lineItems.length >= MAX_LINE_ITEMS}
      onClick={() => onChange({ ...draft, lineItemsReviewed: false, lineItems: [...draft.lineItems,
        { id: crypto.randomUUID(), description: suggestion(), amount: suggestion() }] })}>Add line item</button>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={draft.lineItemsReviewed}
        onChange={(event) => onChange({ ...draft, lineItemsReviewed: event.target.checked })} />
      I checked the complete item list, including missing items
    </label>
  </fieldset>;
}
