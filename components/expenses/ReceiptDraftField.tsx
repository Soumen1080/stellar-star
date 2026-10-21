"use client";

import { useId } from "react";
import { LOW_CONFIDENCE_THRESHOLD, type ReceiptSuggestion } from "@/types/receiptDraft";

export function ReceiptDraftField({ label, field, onChange, type = "text", options }: {
  label: string; field: ReceiptSuggestion; onChange: (value: ReceiptSuggestion) => void;
  type?: string; options?: readonly string[];
}) {
  const id = useId();
  const uncertain = !field.value || field.confidence < LOW_CONFIDENCE_THRESHOLD;
  return <div className="space-y-1">
    <label htmlFor={id} className="block text-sm font-semibold">{label}</label>
    {options ? <select id={id} value={field.value} aria-describedby={`${id}-confidence`}
      onChange={(event) => onChange({ ...field, value: event.target.value, reviewed: false })}
      className="w-full rounded border p-2">
      <option value="">Choose currency</option>
      {options.map((option) => <option key={option}>{option}</option>)}
    </select> : <input id={id} type={type} value={field.value} maxLength={200}
      step={type === "number" ? "0.0000001" : undefined} min={type === "number" ? "0" : undefined}
      aria-describedby={`${id}-confidence`} className="w-full rounded border p-2"
      onChange={(event) => onChange({ ...field, value: event.target.value, reviewed: false })} />}
    <p id={`${id}-confidence`} className={uncertain ? "text-sm text-amber-800" : "text-sm text-gray-600"}>
      {uncertain ? "Low confidence or missing — check the original." : "OCR suggestion — check the original."}
    </p>
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={field.reviewed}
        onChange={(event) => onChange({ ...field, reviewed: event.target.checked })} />
      I checked {label.toLowerCase()} against the receipt
    </label>
  </div>;
}
