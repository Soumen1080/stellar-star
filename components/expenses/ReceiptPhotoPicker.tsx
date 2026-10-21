"use client";

import { OCR_ACCEPT } from "@/lib/receipts/ocr/file";

export function ReceiptPhotoPicker({ onSelect, disabled }: { onSelect: (file: File) => void; disabled: boolean }) {
  const change = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onSelect(file);
  };
  return <div className="space-y-3">
    <label className="block text-sm">Take a receipt photo
      <input className="mt-1 block w-full text-sm" type="file" accept={OCR_ACCEPT} capture="environment"
        disabled={disabled} onChange={change} aria-label="Capture receipt for draft" />
    </label>
    <label className="block text-sm">Choose an existing photo
      <input className="mt-1 block w-full text-sm" type="file" accept={OCR_ACCEPT}
        disabled={disabled} onChange={change} aria-label="Select receipt for draft" />
    </label>
    <p className="text-xs">JPEG, PNG or WebP, up to 4 MiB. OCR runs on this device in English.
      The original stays here until you create the expense, then follows private receipt storage and retention.</p>
  </div>;
}
