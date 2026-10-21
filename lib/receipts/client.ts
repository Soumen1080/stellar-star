"use client";

/**
 * Browser side of receipt attachments. Every call carries the wallet session;
 * the server decides access. Links are never cached past their expiry.
 */

import { getAccessToken } from "@/lib/supabase/session";
import type { ExpenseReceipt, ReceiptLink } from "@/types/receipt";
import { DEFAULT_RECEIPT_MAX_BYTES, RECEIPT_TYPES } from "./policy";

export class ReceiptRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ReceiptRequestError";
    this.status = status;
  }
}

async function call<T>(path: string, init: RequestInit = {}, fetchImpl: typeof fetch = fetch): Promise<T> {
  const token = getAccessToken();
  if (!token) throw new ReceiptRequestError("Sign in with your wallet to use receipts.", 401);
  const res = await fetchImpl(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ReceiptRequestError(body?.error || "The receipt request failed.", res.status);
  return body.data as T;
}

export function listExpenseReceipts(expenseId: string, fetchImpl?: typeof fetch) {
  return call<ExpenseReceipt[]>(`/api/expenses/${encodeURIComponent(expenseId)}/receipts`, {}, fetchImpl);
}

export async function checkReceiptStorage(file: File, fetchImpl?: typeof fetch): Promise<void> {
  const limits = await call<{ maxBytes: number }>("/api/receipts/capabilities", {}, fetchImpl);
  if (!Number.isFinite(limits?.maxBytes) || limits.maxBytes <= 0 || file.size > limits.maxBytes) {
    throw new ReceiptRequestError("This original exceeds the configured receipt storage limit. Choose a smaller photo before creating the expense.", 413);
  }
}

export function uploadExpenseReceipt(
  expenseId: string,
  file: Blob,
  fileName: string,
  caption: string,
  fetchImpl?: typeof fetch,
) {
  const form = new FormData();
  form.append("file", file, fileName);
  if (caption.trim()) form.append("caption", caption.trim());
  return call<ExpenseReceipt>(
    `/api/expenses/${encodeURIComponent(expenseId)}/receipts`,
    { method: "POST", body: form },
    fetchImpl,
  );
}

export function removeExpenseReceipt(receiptId: string, fetchImpl?: typeof fetch) {
  return call<{ removed: boolean }>(`/api/receipts/${encodeURIComponent(receiptId)}`, { method: "DELETE" }, fetchImpl);
}

/** Margin so a link is not handed out seconds before it dies mid-download. */
export const LINK_EXPIRY_MARGIN_MS = 5_000;

export function isReceiptLinkUsable(link: ReceiptLink | null | undefined, now: number = Date.now()): boolean {
  if (!link) return false;
  const expiresAt = new Date(link.expiresAt).getTime();
  return Number.isFinite(expiresAt) && expiresAt - LINK_EXPIRY_MARGIN_MS > now;
}

/**
 * Returns a link that is valid right now: the cached one if it still has
 * life left, otherwise a freshly signed one. An expired link is never opened —
 * the user would just get a storage error page.
 */
export async function freshReceiptLink(
  receiptId: string,
  cache: Map<string, ReceiptLink>,
  { now = Date.now(), fetchImpl }: { now?: number; fetchImpl?: typeof fetch } = {},
): Promise<ReceiptLink> {
  const cached = cache.get(receiptId);
  if (isReceiptLinkUsable(cached, now)) return cached!;
  cache.delete(receiptId);
  const link = await call<ReceiptLink>(`/api/receipts/${encodeURIComponent(receiptId)}`, {}, fetchImpl);
  cache.set(receiptId, link);
  return link;
}

const DOWNSCALABLE = new Set(["image/jpeg", "image/png", "image/webp"]);
const MAX_DIMENSION = 2560;

/**
 * Phone cameras produce photos larger than the upload limit. Large JPEG/PNG/
 * WebP images are re-encoded as JPEG at most 2560px on the long edge, which
 * keeps a receipt legible. PDFs and HEIC (which most browsers cannot decode)
 * pass through untouched and are size-checked by the server.
 */
export async function prepareReceiptFile(
  file: File,
  maxBytes: number = DEFAULT_RECEIPT_MAX_BYTES,
): Promise<{ blob: Blob; fileName: string }> {
  if (file.size <= maxBytes || !DOWNSCALABLE.has(file.type) || typeof createImageBitmap !== "function") {
    return { blob: file, fileName: file.name || defaultName(file.type) };
  }

  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();

    for (const quality of [0.85, 0.7, 0.55]) {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", quality));
      if (blob && blob.size <= maxBytes) {
        return { blob, fileName: (file.name || "receipt").replace(/\.[^.]+$/, "") + ".jpg" };
      }
    }
  } catch {
    // Fall through: send the original and let the server explain the limit.
  }
  return { blob: file, fileName: file.name || defaultName(file.type) };
}

function defaultName(type: string): string {
  const ext = (RECEIPT_TYPES as Record<string, { ext: string }>)[type]?.ext ?? "jpg";
  return `receipt.${ext}`;
}
