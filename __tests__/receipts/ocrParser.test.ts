import { parseReceiptText } from "@/lib/receipts/ocr/parser";

test("extracts merchant, date, explicit total/currency and item candidates without approval", () => {
  const draft = parseReceiptText("Cafe Example\n2026-10-20\nCoffee 3.50\nCake 4.00\nSubtotal 7.50\nTax 0.50\nTOTAL USD 8.00", 92);
  expect(draft.fields.merchant.value).toBe("Cafe Example");
  expect(draft.fields.date.value).toBe("2026-10-20");
  expect(draft.fields.total.value).toBe("8.00");
  expect(draft.fields.currency.value).toBe("USD");
  expect(draft.lineItems.map((line) => line.amount.value)).toEqual(["3.50", "4.00"]);
  expect(Object.values(draft.fields).every((field) => !field.reviewed)).toBe(true);
  expect(draft.lineItemsReviewed).toBe(false);
});
test.each(["", "Cafe\nCoffee 3.50\nCake 4.00", "Cafe\nSubtotal 7.50\nTax 0.50", "Cafe\nTotal 8.00\nTotal 9.00", "Cafe\nTotal 1,234.00"])(
  "never invents a missing or ambiguous total", (text) => expect(parseReceiptText(text, 90).fields.total.value).toBe(""));
test("requires manual interpretation of locale dates and currency symbols", () => {
  const draft = parseReceiptText("Cafe\n03/04/2026\nTotal $8.00", 99);
  expect(draft.fields.currency.value).toBe("");
  expect(draft.fields.date.value).toBe("");
});
test("does not select between different explicit currencies or dates", () => {
  const draft = parseReceiptText("Cafe USD EUR\n2026-10-19\n2026-10-20\nTotal 8.00", 95);
  expect(draft.fields.currency.value).toBe("");
  expect(draft.fields.date.value).toBe("");
});
test("bounds untrusted OCR output and caps heuristic confidence", () => {
  const draft = parseReceiptText("Cafe\n" + "Coffee 1.00\n".repeat(2000), 99);
  expect(draft.lineItems.length).toBe(40);
  expect(draft.fields.merchant.confidence).toBeLessThan(85);
  expect(draft.lineItems.every((line) => line.amount.confidence < 85)).toBe(true);
});
test("invalid confidence metadata stays uncertain", () => {
  const draft = parseReceiptText("Cafe\nTotal USD 8.00", Number.NaN);
  expect(draft.fields.total.confidence).toBe(0);
});
test("uses the existing FX currency whitelist for explicit currency codes", () => {
  expect(parseReceiptText("Cafe\nTOTAL CAD 8.00", 90).fields.currency.value).toBe("CAD");
  expect(parseReceiptText("Cafe\nTOTAL XYZ 8.00", 90).fields.currency.value).toBe("");
});
