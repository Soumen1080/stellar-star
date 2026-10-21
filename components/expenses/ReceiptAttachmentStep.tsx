"use client";

import { useEffect, useRef, useState } from "react";
import { attachReceiptOriginal } from "@/lib/receipts/ocr/attachOriginal";

export function ReceiptAttachmentStep({ expenseId, file, onDone }: {
  expenseId: string; file: File; onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [stored, setStored] = useState(false);
  const [quarantined, setQuarantined] = useState(false);
  const started = useRef(false);
  const inFlight = useRef(false);
  const upload = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError("");
    try {
      // Do not compress or re-encode: attach the exact user-selected original.
      const receipt = await attachReceiptOriginal(expenseId, file);
      setQuarantined(receipt.status === "quarantined");
      setStored(true);
    } catch {
      setError("The expense was created, but its original receipt was not attached. Keep this screen open and retry. No new expense will be created.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => {
    if (!started.current) { started.current = true; void upload(); }
    // This step is mounted once for an immutable expense and file.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <section aria-label="Receipt attachment status" className="space-y-3 pb-20 sm:pb-0">
    <p className="font-semibold">Expense created.</p>
    {busy && <p role="status">Saving the original receipt privately…</p>}
    {error && <p role="alert">{error}</p>}
    {!stored && !busy && <button type="button" className="min-h-11 w-full rounded-xl bg-[#0F0F14] px-4 py-3 text-sm font-semibold text-white" onClick={() => void upload()}>Retry receipt attachment</button>}
    {stored && <>
      <p role="status">{quarantined ? "Original stored in quarantine for safety review. It cannot be downloaded." : "Original receipt saved under the receipt retention policy."}</p>
      <button type="button" className="min-h-11 w-full rounded-xl bg-[#0F0F14] px-4 py-3 text-sm font-semibold text-white" onClick={onDone}>Continue</button>
    </>}
  </section>;
}
