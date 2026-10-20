"use client";

import { useCallback, useEffect, useId, useRef, useState, type ChangeEvent } from "react";
import { Camera, FileText, Paperclip, ShieldAlert, Trash2 } from "lucide-react";
import {
  freshReceiptLink,
  listExpenseReceipts,
  prepareReceiptFile,
  removeExpenseReceipt,
  uploadExpenseReceipt,
  ReceiptRequestError,
} from "@/lib/receipts/client";
import { MAX_CAPTION_LENGTH, RECEIPT_ACCEPT, formatBytes } from "@/lib/receipts/policy";
import type { ExpenseReceipt, ReceiptLink } from "@/types/receipt";

interface ExpenseReceiptsProps {
  expenseId: string;
  /** True when the connected wallet paid for (or created) this expense. */
  canUpload: boolean;
  currentUserPublicKey?: string | null;
}

function describeError(err: unknown): string {
  if (err instanceof ReceiptRequestError) {
    if (err.status === 404) return "You don't have access to this expense's receipts.";
    return err.message;
  }
  return "Something went wrong. Please try again.";
}

/**
 * Receipts attached to one expense. Rendered only inside an expanded card, so
 * nothing is fetched for expenses nobody opens.
 */
export function ExpenseReceipts({ expenseId, canUpload, currentUserPublicKey }: ExpenseReceiptsProps) {
  const id = useId();
  const [receipts, setReceipts] = useState<ExpenseReceipt[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [caption, setCaption] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const links = useRef(new Map<string, ReceiptLink>());

  const refresh = useCallback(async () => {
    try {
      setReceipts(await listExpenseReceipts(expenseId));
      setError(null);
    } catch (err) {
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, [expenseId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const prepared = await prepareReceiptFile(file);
      const saved = await uploadExpenseReceipt(expenseId, prepared.blob, prepared.fileName, caption);
      setCaption("");
      setNotice(
        saved.status === "quarantined"
          ? "Uploaded, but the safety scan held the file back. It will not be shared until reviewed."
          : "Receipt attached.",
      );
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const onView = async (receipt: ExpenseReceipt) => {
    // Open the tab synchronously so the click is not treated as a popup, then
    // point it at a link that is valid *now* — a stale one would 400.
    const tab = window.open("", "_blank");
    try {
      const link = await freshReceiptLink(receipt.id, links.current);
      if (tab) {
        tab.opener = null;
        tab.location.href = link.url;
      } else {
        window.location.assign(link.url);
      }
    } catch (err) {
      tab?.close();
      setError(describeError(err));
    }
  };

  const onRemove = async (receipt: ExpenseReceipt) => {
    setBusy(true);
    setError(null);
    try {
      await removeExpenseReceipt(receipt.id);
      links.current.delete(receipt.id);
      setNotice("Receipt removed.");
      await refresh();
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={`${id}-title`} className="mt-3 pt-3 border-t border-[#F5F5F5]">
      <h3 id={`${id}-title`} className="mb-2 flex items-center gap-1.5 text-xs font-bold text-[#0F0F14]">
        <Paperclip aria-hidden="true" size={12} /> Receipts
      </h3>

      {loading ? (
        <p className="text-xs text-[#AAA]">Loading receipts…</p>
      ) : receipts.length === 0 ? (
        <p className="text-xs text-[#AAA]">No receipts attached.</p>
      ) : (
        <ul className="space-y-1.5">
          {receipts.map((receipt) => {
            const quarantined = receipt.status === "quarantined";
            const mine =
              !!currentUserPublicKey &&
              receipt.uploadedByWallet.toUpperCase() === currentUserPublicKey.toUpperCase();
            return (
              <li key={receipt.id} className="flex items-center justify-between gap-2 rounded-lg bg-[#FAFAFA] px-2.5 py-2">
                <div className="min-w-0">
                  <p className="flex items-center gap-1.5 truncate text-xs font-semibold text-[#0F0F14]">
                    {quarantined ? (
                      <ShieldAlert aria-hidden="true" size={12} className="text-amber-500 shrink-0" />
                    ) : (
                      <FileText aria-hidden="true" size={12} className="text-[#888] shrink-0" />
                    )}
                    <span className="truncate">{receipt.fileName ?? "Receipt"}</span>
                  </p>
                  {receipt.caption && <p className="truncate text-[11px] text-[#666]">{receipt.caption}</p>}
                  <p className="text-[10px] text-[#AAA]">
                    {formatBytes(receipt.sizeBytes)} · {new Date(receipt.createdAt).toLocaleDateString()} · by{" "}
                    {receipt.uploadedByWallet.slice(0, 4)}…{receipt.uploadedByWallet.slice(-4)}
                    {quarantined && " · held by safety scan"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!quarantined && (
                    <button
                      type="button"
                      onClick={() => void onView(receipt)}
                      className="rounded-lg px-2 py-1 text-xs font-semibold text-[#134E4A] hover:bg-[#2DD4BF]/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
                      aria-label={`View ${receipt.fileName ?? "receipt"}`}
                    >
                      View
                    </button>
                  )}
                  {mine && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void onRemove(receipt)}
                      className="rounded-lg p-1.5 text-[#CCC] hover:text-red-500 disabled:opacity-40 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-300"
                      aria-label={`Remove ${receipt.fileName ?? "receipt"}`}
                    >
                      <Trash2 aria-hidden="true" size={12} />
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {canUpload && (
        <div className="mt-2 space-y-2">
          <label htmlFor={`${id}-caption`} className="sr-only">Receipt caption (optional)</label>
          <input
            id={`${id}-caption`}
            type="text"
            value={caption}
            maxLength={MAX_CAPTION_LENGTH}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Caption (optional)"
            className="w-full rounded-lg border border-[#E5E5E5] px-2.5 py-1.5 text-xs outline-none focus:border-[#2DD4BF]"
          />
          <div className="flex flex-wrap gap-2">
            {/* `capture` opens the rear camera directly on phones; desktop browsers ignore it. */}
            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-[#0F0F14] px-3 py-1.5 text-xs font-bold text-[#2DD4BF] focus-within:ring-2 focus-within:ring-[#2DD4BF] ${busy ? "opacity-50 pointer-events-none" : ""}`}>
              <Camera aria-hidden="true" size={12} />
              Take photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="sr-only"
                disabled={busy}
                onChange={(event) => void onFile(event)}
                aria-label="Take a photo of the receipt"
              />
            </label>
            <label className={`inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-[#E5E5E5] px-3 py-1.5 text-xs font-semibold text-[#0F0F14] focus-within:ring-2 focus-within:ring-[#2DD4BF] ${busy ? "opacity-50 pointer-events-none" : ""}`}>
              <Paperclip aria-hidden="true" size={12} />
              Choose file
              <input
                type="file"
                accept={RECEIPT_ACCEPT}
                className="sr-only"
                disabled={busy}
                onChange={(event) => void onFile(event)}
                aria-label="Choose a receipt file"
              />
            </label>
          </div>
          <p className="text-[10px] text-[#AAA]">JPEG, PNG, WebP, HEIC or PDF. Stored privately; never on-chain.</p>
        </div>
      )}

      <div aria-live="polite" className="mt-1.5 text-[11px]">
        {busy && <p className="text-[#888]">Uploading…</p>}
        {notice && !busy && <p className="text-[#134E4A]">{notice}</p>}
      </div>
      {error && (
        <p role="alert" className="mt-1.5 text-[11px] text-red-500">
          {error}
        </p>
      )}
    </section>
  );
}
