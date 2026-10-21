import { File } from "node:buffer";
import { validateOcrFile } from "@/lib/receipts/ocr/file";

const photo = (bytes: number[], type = "image/jpeg") => new File([new Uint8Array(bytes)], "photo.jpg", { type }) as unknown as globalThis.File;
test("accepts camera captures with missing or generic MIME using their bytes", async () => {
  await expect(validateOcrFile(photo([255, 216, 255], ""))).resolves.toBeUndefined();
  await expect(validateOcrFile(photo([255, 216, 255], "application/octet-stream"))).resolves.toBeUndefined();
});
test("rejects spoofed and unsupported content before creating an OCR worker", async () => {
  await expect(validateOcrFile(photo([255, 216, 255], "image/png"))).rejects.toThrow("JPEG");
  await expect(validateOcrFile(photo([60, 115, 99, 114, 105, 112, 116]))).rejects.toThrow("JPEG");
});
test("refuses empty or oversized originals instead of silently recompressing", async () => {
  await expect(validateOcrFile(photo([]))).rejects.toThrow("original");
  const large = new File([new Uint8Array(4 * 1024 * 1024 + 1)], "large.jpg") as unknown as globalThis.File;
  await expect(validateOcrFile(large)).rejects.toThrow("4 MiB");
});
