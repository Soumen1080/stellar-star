import { positiveReceiptAmount, receiptAmount } from "@/lib/receipts/ocr/amount";

test.each(["1,234.00", "12,50", "1.234,00", "-1", "1e3", "Infinity", "NaN", "12usd", "", "0.00000001"])(
  "does not guess or coerce ambiguous amount %s", (value) => expect(receiptAmount(value)).toBeNull());
test.each(["0", "12.50", "1234", "0.0000001"])("preserves explicit decimal %s", (value) => {
  expect(receiptAmount(value)).toBe(value);
});
test("total must be positive, while a free line item can be zero", () => {
  expect(positiveReceiptAmount("0.00")).toBe(false);
  expect(receiptAmount("0.00")).toBe("0.00");
  expect(positiveReceiptAmount("0.01")).toBe(true);
});
