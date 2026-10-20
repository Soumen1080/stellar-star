/**
 * Receipt attachment policy (issue #318) — the limits every layer enforces.
 *
 * Receipts are private documents (names, card digits, addresses). They live in
 * a private storage bucket, never in this repository and never on-chain, and
 * are only ever served through short-lived signed URLs after a membership
 * check. See docs/RECEIPT_ATTACHMENTS.md.
 */

export const RECEIPT_BUCKET = "expense-receipts";

/**
 * The allowlist. Keys are the canonical content types stored in metadata; the
 * type is decided by sniffing the file's magic bytes, never by trusting the
 * browser-declared type or the extension. SVG and HTML are absent on purpose:
 * both can carry script.
 */
export const RECEIPT_TYPES = {
  "image/jpeg": { ext: "jpg", label: "JPEG image" },
  "image/png": { ext: "png", label: "PNG image" },
  "image/webp": { ext: "webp", label: "WebP image" },
  "image/heic": { ext: "heic", label: "HEIC photo" },
  "image/heif": { ext: "heif", label: "HEIF photo" },
  "application/pdf": { ext: "pdf", label: "PDF document" },
} as const;

export type ReceiptContentType = keyof typeof RECEIPT_TYPES;

export const RECEIPT_CONTENT_TYPES = Object.keys(RECEIPT_TYPES) as ReceiptContentType[];

/** For `<input accept>`. */
export const RECEIPT_ACCEPT = "image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf";

/**
 * 4 MiB default. Serverless platforms cap request bodies (Vercel at 4.5 MB),
 * so a larger limit would only move the failure somewhere less helpful. The
 * client downsizes large photos before upload to stay under it.
 */
export const DEFAULT_RECEIPT_MAX_BYTES = 4 * 1024 * 1024;

export function receiptMaxBytes(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.RECEIPT_MAX_BYTES);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RECEIPT_MAX_BYTES;
}

export const MAX_RECEIPTS_PER_EXPENSE = 10;
export const MAX_CAPTION_LENGTH = 200;
export const MAX_FILE_NAME_LENGTH = 120;

/** Signed download links live for one minute; the client asks again when needed. */
export const SIGNED_URL_TTL_SECONDS = 60;

/**
 * How long a receipt is kept before the retention sweep removes the file.
 * Two years by default, covering a typical reimbursement/tax dispute window.
 */
export const DEFAULT_RECEIPT_RETENTION_DAYS = 730;

export function receiptRetentionDays(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.RECEIPT_RETENTION_DAYS);
  return Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RECEIPT_RETENTION_DAYS;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
