/**
 * Tests for OCR queue operations (issue #452).
 */

import { OcrQueueError } from "@/lib/receipts/ocr/queue";
import { OcrQuotaError } from "@/lib/receipts/ocr/quota";

describe("OcrQueueError", () => {
  it("has correct name and status", () => {
    const err = new OcrQueueError("test", 409);
    expect(err.name).toBe("OcrQueueError");
    expect(err.status).toBe(409);
    expect(err.message).toBe("test");
  });

  it("defaults to 500 status", () => {
    const err = new OcrQueueError("test");
    expect(err.status).toBe(500);
  });
});

describe("OcrQuotaError", () => {
  it("has correct name, status 429, and retryAfterSeconds", () => {
    const err = new OcrQuotaError("quota exceeded", 900);
    expect(err.name).toBe("OcrQuotaError");
    expect(err.status).toBe(429);
    expect(err.retryAfterSeconds).toBe(900);
  });

  it("defaults retryAfterSeconds to null", () => {
    const err = new OcrQuotaError("quota exceeded");
    expect(err.retryAfterSeconds).toBeNull();
  });
});
