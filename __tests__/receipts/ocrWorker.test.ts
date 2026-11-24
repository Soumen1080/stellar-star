/**
 * Tests for OCR worker processing logic (issue #452).
 */

import { parseReceiptText, MAX_OCR_LINES, MAX_LINE_ITEMS } from "@/lib/receipts/ocr/parser";

describe("OCR worker parsing", () => {
  it("parses a typical receipt text into fields", () => {
    const text = [
      "ACME GROCERY",
      "2024-06-15",
      "Bananas 2.50",
      "Milk 3.99",
      "Bread 2.00",
      "Total: 8.49",
    ].join("\n");

    const draft = parseReceiptText(text, 85);

    expect(draft.fields.merchant.value).toBe("ACME GROCERY");
    expect(draft.fields.date.value).toBe("2024-06-15");
    expect(draft.fields.total.value).toBe("8.49");
    expect(draft.lineItems.length).toBeGreaterThanOrEqual(2);
    // Confidence is capped at 75 for suggestions.
    expect(draft.fields.merchant.confidence).toBeLessThanOrEqual(75);
    // Not reviewed yet.
    expect(draft.fields.merchant.reviewed).toBe(false);
    expect(draft.lineItemsReviewed).toBe(false);
  });

  it("caps lines at MAX_OCR_LINES", () => {
    const lines = Array.from({ length: MAX_OCR_LINES + 50 }, (_, i) => `Line ${i} 1.00`);
    const draft = parseReceiptText(lines.join("\n"), 90);
    // Should not throw and should cap the parsed items.
    expect(draft.lineItems.length).toBeLessThanOrEqual(MAX_LINE_ITEMS);
  });

  it("caps line items at MAX_LINE_ITEMS", () => {
    const lines = ["SHOP", ...Array.from({ length: 100 }, (_, i) => `Item${i} ${(i + 1).toFixed(2)}`)];
    const draft = parseReceiptText(lines.join("\n"), 80);
    expect(draft.lineItems.length).toBeLessThanOrEqual(MAX_LINE_ITEMS);
  });

  it("handles empty text gracefully", () => {
    const draft = parseReceiptText("", 0);
    expect(draft.fields.merchant.value).toBe("");
    expect(draft.fields.date.value).toBe("");
    expect(draft.fields.total.value).toBe("");
    expect(draft.lineItems.length).toBe(0);
  });

  it("handles multiple dates — none suggested when ambiguous", () => {
    const text = "SHOP\n2024-01-01\n2024-12-31\nItem 5.00\nTotal: 5.00";
    const draft = parseReceiptText(text, 90);
    // Multiple dates → ambiguous → empty.
    expect(draft.fields.date.value).toBe("");
  });

  it("handles multiple totals — none suggested when ambiguous", () => {
    const text = "SHOP\n2024-06-15\nTotal: 10.00\nTotal: 20.00";
    const draft = parseReceiptText(text, 90);
    expect(draft.fields.total.value).toBe("");
  });

  it("extracts currency code from text", () => {
    const text = "SHOP\n2024-06-15\nItem 5.00 USD\nTotal: 5.00";
    const draft = parseReceiptText(text, 90);
    expect(draft.fields.currency.value).toBe("USD");
  });

  it("truncates very long text input", () => {
    const longText = "A".repeat(50_000);
    // Should not throw.
    const draft = parseReceiptText(longText, 50);
    expect(draft).toBeDefined();
  });
});
