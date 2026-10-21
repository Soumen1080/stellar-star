/** @jest-environment jsdom */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { ReceiptDraftReview } from "@/components/expenses/ReceiptDraftReview";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";

const useDraft = jest.fn();
function Review() {
  const [draft, setDraft] = useState(() => parseReceiptText("Cafe\n2026-10-20\nTea 8.00\nTotal USD 8.00", 99));
  return <ReceiptDraftReview draft={draft} onChange={setDraft} onUse={useDraft} />;
}
beforeEach(() => useDraft.mockClear());
test("requires every confirmation and invalidates a changed field", () => {
  render(<Review />);
  const apply = screen.getByRole("button", { name: "Use reviewed receipt draft" }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  screen.getAllByRole("checkbox").forEach((checkbox) => fireEvent.click(checkbox));
  expect(apply.disabled).toBe(false);
  fireEvent.change(screen.getByLabelText("Receipt total"), { target: { value: "9.00" } });
  expect(apply.disabled).toBe(true);
  fireEvent.click(screen.getByLabelText("I checked receipt total against the receipt"));
  fireEvent.click(apply);
  expect(useDraft).toHaveBeenCalledTimes(1);
});
test("signals low confidence in text and makes additions require review", () => {
  render(<Review />);
  expect(screen.getAllByText(/Low confidence or missing/).length).toBeGreaterThan(0);
  screen.getAllByRole("checkbox").forEach((checkbox) => fireEvent.click(checkbox));
  fireEvent.click(screen.getByRole("button", { name: "Add line item" }));
  expect((screen.getByRole("button", { name: "Use reviewed receipt draft" }) as HTMLButtonElement).disabled).toBe(true);
  expect((screen.getByLabelText("I checked the complete item list, including missing items") as HTMLInputElement).checked).toBe(false);
});
