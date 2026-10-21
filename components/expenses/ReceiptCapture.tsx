"use client";

import { useReceiptCapture } from "@/hooks/useReceiptCapture";
import { canUseReceiptDraft } from "@/lib/receipts/ocr/review";
import type { ReceiptDraft } from "@/types/receiptDraft";
import { ReceiptDraftReview } from "./ReceiptDraftReview";
import { ReceiptPhotoPicker } from "./ReceiptPhotoPicker";
import { ReceiptPhotoPreview } from "./ReceiptPhotoPreview";

export function ReceiptCapture({ onUse, onCancel }: {
  onUse: (draft: ReceiptDraft, file: File) => void; onCancel: () => void;
}) {
  const capture = useReceiptCapture();
  return <section aria-label="Receipt draft capture" className="space-y-4 rounded-xl border p-4">
    <h2 className="font-bold">Create a draft from a receipt</h2>
    <ReceiptPhotoPicker onSelect={(file) => void capture.select(file)} disabled={capture.busy} />
    {capture.error && <p role="alert">{capture.error}</p>}
    {capture.file && <>
      <ReceiptPhotoPreview file={capture.file} />
      {!capture.draft && <div className="flex flex-wrap gap-3">
        <button type="button" disabled={capture.busy} onClick={() => void capture.extract()}>Extract fields on this device</button>
        <button type="button" disabled={capture.busy} onClick={capture.manual}>Enter receipt fields manually</button>
      </div>}
      {capture.busy && <p role="status">Reading receipt: {capture.progress}%</p>}
      {capture.draft && <ReceiptDraftReview draft={capture.draft} onChange={capture.setDraft}
        onUse={() => { if (capture.file && capture.draft && canUseReceiptDraft(capture.draft)) onUse(capture.draft, capture.file); }} />}
    </>}
    <button type="button" onClick={() => { capture.reset(); onCancel(); }}>Discard receipt draft</button>
  </section>;
}
