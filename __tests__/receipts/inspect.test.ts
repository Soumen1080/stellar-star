import {
  ReceiptValidationError,
  inspectReceiptUpload,
  sanitizeFileName,
  scanReceipt,
  sha256Hex,
  sniffReceiptType,
} from "@/lib/receipts/inspect";
import { canRemoveReceipt, canUploadReceipt, receiptViewDecision } from "@/lib/receipts/access";
import { receiptStoragePath } from "@/lib/receipts/store";

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const bytes = (text: string) => new Uint8Array(Buffer.from(text, "latin1"));
const HEIC = bytes("\u0000\u0000\u0000\u0018ftypheic\u0000\u0000\u0000\u0000mif1heic");
const WEBP = bytes("RIFF\u0010\u0000\u0000\u0000WEBPVP8 ");
const PDF = bytes("%PDF-1.7\n1 0 obj << /Type /Catalog >> endobj\n%%EOF");

function statusOf(fn: () => unknown): number | undefined {
  try {
    fn();
  } catch (err) {
    return (err as ReceiptValidationError).status;
  }
  return undefined;
}

function inspect(overrides: Partial<Parameters<typeof inspectReceiptUpload>[0]> = {}) {
  return inspectReceiptUpload({
    bytes: JPEG,
    declaredType: "image/jpeg",
    fileName: "dinner.jpg",
    caption: null,
    maxBytes: 1024,
    ...overrides,
  });
}

describe("sniffReceiptType", () => {
  it.each([
    [JPEG, "image/jpeg"],
    [PNG, "image/png"],
    [WEBP, "image/webp"],
    [HEIC, "image/heic"],
    [PDF, "application/pdf"],
    [bytes("<svg xmlns='http://www.w3.org/2000/svg'/>"), null],
    [bytes("<html><body>hi</body></html>"), null],
    [bytes("GIF89a"), null],
  ])("identifies %#", (input, expected) => {
    expect(sniffReceiptType(input)).toBe(expected);
  });
});

describe("inspectReceiptUpload", () => {
  it("accepts an allowlisted file and records size and checksum", () => {
    const result = inspect();
    expect(result.contentType).toBe("image/jpeg");
    expect(result.sizeBytes).toBe(JPEG.length);
    expect(result.checksum).toBe(sha256Hex(JPEG));
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(result.scan.verdict).toBe("clean");
  });

  it("accepts a mobile camera capture sent as application/octet-stream", () => {
    const result = inspect({ bytes: HEIC, declaredType: "application/octet-stream", fileName: "image.heic" });
    expect(result.contentType).toBe("image/heic");
    expect(result.ext).toBe("heic");
  });

  it("accepts a capture with no declared type and no name", () => {
    const result = inspect({ declaredType: "", fileName: "" });
    expect(result.fileName).toBe("receipt.jpg");
  });

  it("accepts common type aliases", () => {
    expect(inspect({ declaredType: "image/jpg" }).contentType).toBe("image/jpeg");
  });

  it("rejects disallowed types with 415", () => {
    expect(statusOf(() => inspect({ bytes: bytes("<svg onload=alert(1)>"), declaredType: "image/svg+xml" }))).toBe(415);
  });

  it("rejects a file whose bytes contradict its declared type", () => {
    expect(() => inspect({ bytes: PDF, declaredType: "image/png" })).toThrow(/do not match/);
  });

  it("enforces the size limit with 413", () => {
    const big = new Uint8Array(2048);
    big.set(JPEG);
    expect(statusOf(() => inspect({ bytes: big }))).toBe(413);
  });

  it("rejects empty files", () => {
    expect(() => inspect({ bytes: new Uint8Array() })).toThrow(ReceiptValidationError);
  });

  it("limits caption length", () => {
    expect(() => inspect({ caption: "x".repeat(201) })).toThrow(/Caption/);
    expect(inspect({ caption: "  Dinner   at  the  beach " }).caption).toBe("Dinner at the beach");
  });
});

describe("scanReceipt — quarantine decisions", () => {
  it("quarantines PDFs with active content", () => {
    const evil = bytes("%PDF-1.7\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>");
    const result = scanReceipt(evil, "application/pdf");
    expect(result.verdict).toBe("quarantine");
    expect(result.reasons).toContain("pdf_javascript");
  });

  it("quarantines PDFs that launch programs or embed files", () => {
    expect(scanReceipt(bytes("%PDF-1.4 /Launch /F (cmd.exe)"), "application/pdf").reasons).toContain(
      "pdf_launch_action",
    );
    expect(scanReceipt(bytes("%PDF-1.4 /EmbeddedFile"), "application/pdf").reasons).toContain(
      "pdf_embedded_file",
    );
  });

  it("quarantines image/script polyglots", () => {
    const polyglot = new Uint8Array(Buffer.concat([JPEG, bytes("<script>alert(1)</script>")]));
    expect(scanReceipt(polyglot, "image/jpeg")).toMatchObject({ verdict: "quarantine", reasons: ["embedded_script"] });
  });

  it("passes ordinary files", () => {
    expect(scanReceipt(PDF, "application/pdf").verdict).toBe("clean");
    expect(scanReceipt(PNG, "image/png").verdict).toBe("clean");
  });
});

describe("file names and storage paths", () => {
  it("strips path traversal and control characters from display names", () => {
    expect(sanitizeFileName("../../etc/passwd", "pdf")).toBe("passwd");
    expect(sanitizeFileName("C:\\Users\\me\\bill\u0000.pdf", "pdf")).toBe("bill.pdf");
    expect(sanitizeFileName("..", "png")).toBe("receipt.png");
  });

  it("builds storage paths from server ids only, separating quarantine", () => {
    expect(receiptStoragePath("e1", "r1", "jpg", false)).toBe("receipts/e1/r1.jpg");
    expect(receiptStoragePath("e1", "r1", "jpg", true)).toBe("quarantine/e1/r1.jpg");
  });
});

describe("access rules", () => {
  const access = { expenseId: "e1", createdByWallet: "GCREATOR", payerWallet: "GPAYER" };

  it("lets the payer or the creator upload, nobody else", () => {
    expect(canUploadReceipt(access, "gpayer")).toBe(true);
    expect(canUploadReceipt(access, "GCREATOR")).toBe(true);
    expect(canUploadReceipt(access, "GMEMBER")).toBe(false);
    expect(canUploadReceipt({ ...access, payerWallet: null }, "GMEMBER")).toBe(false);
  });

  it("lets the uploader or the expense creator remove", () => {
    expect(canRemoveReceipt({ uploadedByWallet: "GPAYER" }, access, "GPAYER")).toBe(true);
    expect(canRemoveReceipt({ uploadedByWallet: "GPAYER" }, access, "GCREATOR")).toBe(true);
    expect(canRemoveReceipt({ uploadedByWallet: "GPAYER" }, access, "GMEMBER")).toBe(false);
  });

  it("never serves quarantined or removed receipts", () => {
    expect(receiptViewDecision({ status: "active" })).toEqual({ ok: true });
    expect(receiptViewDecision({ status: "quarantined" })).toMatchObject({ ok: false, status: 403 });
    expect(receiptViewDecision({ status: "removed" })).toMatchObject({ ok: false, status: 410 });
  });
});
