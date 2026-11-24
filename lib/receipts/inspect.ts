/**
 * Server-side inspection of an uploaded receipt: type sniffing, size limits and
 * the content scan that decides between storing a file and quarantining it.
 *
 * Pure functions over bytes, so every rule here is unit-tested without storage.
 */

import { createHash } from "crypto";
import {
  MAX_CAPTION_LENGTH,
  MAX_FILE_NAME_LENGTH,
  RECEIPT_TYPES,
  formatBytes,
  type ReceiptContentType,
} from "./policy";

export class ReceiptValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ReceiptValidationError";
    this.status = status;
  }
}

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return Buffer.from(bytes.subarray(start, end)).toString("latin1");
}

/** The content type the bytes actually are, or null when not on the allowlist. */
export function sniffReceiptType(bytes: Uint8Array): ReceiptContentType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  ) {
    return "image/png";
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp") {
    const brand = ascii(bytes, 8, 12);
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
  }
  if (bytes.length >= 5 && ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  return null;
}

/**
 * Browser-declared types that carry no information. Mobile browsers commonly
 * send camera captures as `application/octet-stream` or with no type at all;
 * those are decided by sniffing alone.
 */
const UNINFORMATIVE_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/** Declared types accepted as the same thing as a sniffed type. */
const TYPE_ALIASES: Record<string, ReceiptContentType> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/heic-sequence": "image/heic",
  "image/heif-sequence": "image/heif",
  "application/x-pdf": "application/pdf",
};

export interface ScanResult {
  verdict: "clean" | "quarantine";
  /** Machine-readable reasons, stored with the receipt for review. */
  reasons: string[];
  scanner: string;
}

/**
 * Markers of active content. A receipt is a picture or a printed page; none of
 * these have a legitimate reason to be inside one.
 */
const PDF_ACTIVE_CONTENT: Array<[RegExp, string]> = [
  [/\/JavaScript\b/, "pdf_javascript"],
  [/\/JS\b/, "pdf_javascript"],
  [/\/Launch\b/, "pdf_launch_action"],
  [/\/EmbeddedFile\b/, "pdf_embedded_file"],
  [/\/RichMedia\b/, "pdf_rich_media"],
  [/\/XFA\b/, "pdf_xfa_form"],
  [/\/Encrypt\b/, "pdf_encrypted_uninspectable"],
  [/\/SubmitForm\b/, "pdf_submit_form"],
  [/\/ImportData\b/, "pdf_import_data"],
  [/\/GoToR\b/, "pdf_remote_goto"],
];

const POLYGLOT_MARKERS: Array<[RegExp, string]> = [
  [/<script[\s>]/i, "embedded_script"],
  [/<\?php/i, "embedded_php"],
  [/<html[\s>]/i, "embedded_html"],
  [/<svg[\s>]/i, "embedded_svg"],
  [/<iframe[\s>]/i, "embedded_iframe"],
  [/<object[\s>]/i, "embedded_object"],
  [/<embed[\s>]/i, "embedded_embed"],
  [/<applet[\s>]/i, "embedded_applet"],
  [/javascript:/i, "embedded_javascript_uri"],
  [/vbscript:/i, "embedded_vbscript_uri"],
  [/\bon(error|load|unload|click|mouse|key)\s*=/i, "embedded_event_handler"],
];

/**
 * The built-in scanner: static heuristic scan for malware, executable binaries,
 * polyglots, and active PDF content (issue #451). Anything flagged is quarantined
 * rather than served.
 */
export function scanReceipt(bytes: Uint8Array, type: ReceiptContentType): ScanResult {
  // latin1 maps every byte to one character, so byte patterns survive decoding.
  const text = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  const reasons = new Set<string>();

  // Check for binary executable headers (PE/ELF/Mach-O/Shell scripts)
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    reasons.add("malware_executable_pe");
  }
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) {
    reasons.add("malware_executable_elf");
  }
  if (bytes.length >= 4) {
    const isMacho =
      (bytes[0] === 0xfe && bytes[1] === 0xed && bytes[2] === 0xfa && (bytes[3] === 0xce || bytes[3] === 0xcf)) ||
      (bytes[0] === 0xce && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
      (bytes[0] === 0xcf && bytes[1] === 0xfa && bytes[2] === 0xed && bytes[3] === 0xfe) ||
      (bytes[0] === 0xca && bytes[1] === 0xfe && bytes[2] === 0xba && bytes[3] === 0xbe && type !== "image/jpeg");
    if (isMacho) reasons.add("malware_executable_macho");
  }
  if (bytes.length >= 3 && bytes[0] === 0x23 && bytes[1] === 0x21 && bytes[2] === 0x2f) {
    reasons.add("malware_shell_script");
  }

  if (type === "application/pdf") {
    for (const [pattern, reason] of PDF_ACTIVE_CONTENT) if (pattern.test(text)) reasons.add(reason);
  }
  for (const [pattern, reason] of POLYGLOT_MARKERS) if (pattern.test(text)) reasons.add(reason);

  return {
    verdict: reasons.size > 0 ? "quarantine" : "clean",
    reasons: [...reasons].sort(),
    scanner: "builtin-heuristic-v2",
  };
}

/** Strips path components and control characters; never used to build a storage path. */
export function sanitizeFileName(raw: string | null | undefined, ext: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001f\u007f"<>|*?:]/g, "").replace(/\s+/g, " ").trim();
  const name = Array.from(cleaned).slice(0, MAX_FILE_NAME_LENGTH).join("");
  return name && name !== "." && name !== ".." ? name : `receipt.${ext}`;
}

export function normalizeCaption(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") throw new ReceiptValidationError("Caption must be text.");
  const caption = raw.replace(/\s+/g, " ").trim();
  if (caption.length > MAX_CAPTION_LENGTH) {
    throw new ReceiptValidationError(`Caption must be at most ${MAX_CAPTION_LENGTH} characters.`);
  }
  return caption || null;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface InspectedReceipt {
  contentType: ReceiptContentType;
  ext: string;
  sizeBytes: number;
  checksum: string;
  fileName: string;
  caption: string | null;
  scan: ScanResult;
}

export function inspectReceiptUpload({
  bytes,
  declaredType,
  fileName,
  caption,
  maxBytes,
}: {
  bytes: Uint8Array;
  declaredType: string | null | undefined;
  fileName: string | null | undefined;
  caption: unknown;
  maxBytes: number;
}): InspectedReceipt {
  if (bytes.length === 0) throw new ReceiptValidationError("The file is empty.");
  if (bytes.length > maxBytes) {
    throw new ReceiptValidationError(`Receipts must be ${formatBytes(maxBytes)} or smaller.`, 413);
  }

  const contentType = sniffReceiptType(bytes);
  if (!contentType) {
    throw new ReceiptValidationError(
      "Unsupported file type. Upload a JPEG, PNG, WebP or HEIC photo, or a PDF.",
      415,
    );
  }

  const declared = (declaredType ?? "").trim().toLowerCase().split(";")[0];
  const declaredCanonical = TYPE_ALIASES[declared] ?? declared;
  if (!UNINFORMATIVE_TYPES.has(declared) && declaredCanonical !== contentType) {
    // A file claiming to be one thing while being another is the classic way to
    // smuggle content past a type check, so it is refused outright.
    throw new ReceiptValidationError(
      "The file's contents do not match its type. Re-export it and try again.",
      415,
    );
  }

  const { ext } = RECEIPT_TYPES[contentType];
  return {
    contentType,
    ext,
    sizeBytes: bytes.length,
    checksum: sha256Hex(bytes),
    fileName: sanitizeFileName(fileName, ext),
    caption: normalizeCaption(caption),
    scan: scanReceipt(bytes, contentType),
  };
}
