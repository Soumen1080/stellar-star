import { DEFAULT_RECEIPT_MAX_BYTES } from "@/lib/receipts/policy";

export const OCR_ACCEPT = "image/jpeg,image/png,image/webp";

/** OCR supports decodable photos; attachment inspection on the server is authoritative. */
export async function validateOcrFile(file: File): Promise<void> {
  if (!file.size || file.size > DEFAULT_RECEIPT_MAX_BYTES) {
    throw new Error("Choose a photo up to 4 MiB. The original will be preserved without compression.");
  }
  const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  const png = [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.slice(start, end));
  const webp = ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP";
  const type = jpeg ? "image/jpeg" : png ? "image/png" : webp ? "image/webp" : null;
  if (!type || (file.type && file.type !== "application/octet-stream" && file.type !== type)) {
    throw new Error("Use a JPEG, PNG or WebP photo for OCR. PDF and HEIC can be attached after manual expense creation.");
  }
}
