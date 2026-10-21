import { parseReceiptText } from "@/lib/receipts/ocr/parser";
import { canUseReceiptDraft, receiptDraftDescription } from "@/lib/receipts/ocr/review";
import { RECEIPT_FIELDS } from "@/types/receiptDraft";

function reviewed() {
  const draft = parseReceiptText("Cafe\n2026-10-20\nTea 8.00\nTOTAL USD 8.00", 99);
  Object.values(draft.fields).forEach((field) => { field.reviewed = true; });
  draft.lineItems.forEach((line) => { line.description.reviewed = true; line.amount.reviewed = true; });
  draft.lineItemsReviewed = true;
  return draft;
}
test.each(RECEIPT_FIELDS)("requires individual review of %s even at high confidence", (key) => {
  const draft = reviewed();
  expect(canUseReceiptDraft(draft)).toBe(true);
  draft.fields[key].reviewed = false;
  expect(canUseReceiptDraft(draft)).toBe(false);
});
test.each(["description", "amount"] as const)("requires review of every line %s", (key) => {
  const draft = reviewed(); draft.lineItems[0][key].reviewed = false;
  expect(canUseReceiptDraft(draft)).toBe(false);
});
test("requires list completeness confirmation, including an empty list", () => {
  const draft = reviewed(); draft.lineItems = []; draft.lineItemsReviewed = false;
  expect(canUseReceiptDraft(draft)).toBe(false);
  draft.lineItemsReviewed = true;
  expect(canUseReceiptDraft(draft)).toBe(true);
});
test.each([["date", "2026-02-30"], ["total", "0"], ["total", "1e3"], ["currency", "XYZ"], ["merchant", " "]] as const)(
  "confirmation cannot make invalid %s valid", (key, value) => {
    const draft = reviewed(); draft.fields[key].value = value;
    expect(canUseReceiptDraft(draft)).toBe(false);
  });
test("preserves reviewed date and items without replacing or calculating the total", () => {
  const draft = reviewed(); draft.lineItems[0].amount.value = "3.00";
  expect(canUseReceiptDraft(draft)).toBe(true);
  expect(draft.fields.total.value).toBe("8.00");
  expect(receiptDraftDescription(draft)).toBe("Receipt date: 2026-10-20\nTea: 3.00 USD");
});
