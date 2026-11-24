/**
 * Tests for OCR result persistence and review gate (issue #452).
 */

import { parseReceiptText } from "@/lib/receipts/ocr/parser";
import { canUseReceiptDraft } from "@/lib/receipts/ocr/review";
import { suggestion } from "@/types/receiptDraft";
import type { ReceiptDraft } from "@/types/receiptDraft";

describe("OCR result to draft conversion", () => {
  it("parseReceiptText returns draft with un-reviewed suggestions", () => {
    const text = [
      "COFFEE SHOP",
      "2024-06-15",
      "Latte 4.50",
      "Muffin 3.00",
      "Total: 7.50",
    ].join("\n");
    const draft = parseReceiptText(text, 90);
    expect(draft.fields.merchant.reviewed).toBe(false);
    expect(draft.fields.date.reviewed).toBe(false);
    expect(draft.fields.total.reviewed).toBe(false);
    expect(draft.lineItemsReviewed).toBe(false);
  });
});

describe("Review gate enforcement", () => {
  function reviewedDraft(): ReceiptDraft {
    return {
      fields: {
        merchant: { value: "Coffee Shop", confidence: 90, reviewed: true },
        date: { value: "2024-06-15", confidence: 90, reviewed: true },
        total: { value: "7.50", confidence: 90, reviewed: true },
        currency: { value: "USD", confidence: 90, reviewed: true },
      },
      lineItems: [],
      lineItemsReviewed: true,
    };
  }

  it("accepts a fully reviewed draft", () => {
    expect(canUseReceiptDraft(reviewedDraft())).toBe(true);
  });

  it("rejects when merchant is not reviewed", () => {
    const draft = reviewedDraft();
    draft.fields.merchant.reviewed = false;
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when date is not reviewed", () => {
    const draft = reviewedDraft();
    draft.fields.date.reviewed = false;
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when total is not reviewed", () => {
    const draft = reviewedDraft();
    draft.fields.total.reviewed = false;
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when currency is not reviewed", () => {
    const draft = reviewedDraft();
    draft.fields.currency.reviewed = false;
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when lineItems are not reviewed", () => {
    const draft = reviewedDraft();
    draft.lineItemsReviewed = false;
    draft.lineItems = [
      {
        id: "1",
        description: { value: "Latte", confidence: 90, reviewed: true },
        amount: { value: "4.50", confidence: 90, reviewed: true },
      },
    ];
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when a line item description is not reviewed", () => {
    const draft = reviewedDraft();
    draft.lineItemsReviewed = true;
    draft.lineItems = [
      {
        id: "1",
        description: { value: "Latte", confidence: 90, reviewed: false },
        amount: { value: "4.50", confidence: 90, reviewed: true },
      },
    ];
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when date value is invalid", () => {
    const draft = reviewedDraft();
    draft.fields.date.value = "not-a-date";
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when total value is zero", () => {
    const draft = reviewedDraft();
    draft.fields.total.value = "0.00";
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects when merchant is empty", () => {
    const draft = reviewedDraft();
    draft.fields.merchant.value = "   ";
    expect(canUseReceiptDraft(draft)).toBe(false);
  });

  it("rejects unsupported currency", () => {
    const draft = reviewedDraft();
    draft.fields.currency.value = "ZZZ";
    expect(canUseReceiptDraft(draft)).toBe(false);
  });
});

describe("suggestion helper", () => {
  it("creates un-reviewed suggestion with clamped confidence", () => {
    const s = suggestion("hello", 150);
    expect(s.value).toBe("hello");
    expect(s.confidence).toBe(100);
    expect(s.reviewed).toBe(false);
  });

  it("defaults to empty value and zero confidence", () => {
    const s = suggestion();
    expect(s.value).toBe("");
    expect(s.confidence).toBe(0);
    expect(s.reviewed).toBe(false);
  });
});
