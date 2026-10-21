/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";
import { attachReceiptOriginal } from "@/lib/receipts/ocr/attachOriginal";
import type { ExpenseReceipt } from "@/types/receipt";
import { checkReceiptStorage } from "@/lib/receipts/client";
jest.mock("@/lib/receipts/client", () => ({ ...jest.requireActual("@/lib/receipts/client"), checkReceiptStorage: jest.fn().mockResolvedValue(undefined) }));

const addExpense = jest.fn().mockResolvedValue(undefined);
const original = new File(["unchanged original"], "receipt.jpg");
jest.mock("@/hooks/useExpense", () => ({ useExpense: () => ({ addExpense }) }));
jest.mock("@/components/ui/Toast", () => ({ useToast: () => ({ success: jest.fn(), error: jest.fn() }) }));
jest.mock("@/lib/receipts/ocr/attachOriginal", () => ({ attachReceiptOriginal: jest.fn() }));
jest.mock("@/components/expenses/ReceiptCapture", () => ({ ReceiptCapture: ({ onUse }: { onUse: (draft: ReturnType<typeof parseReceiptText>, file: File) => void }) =>
  <button type="button" onClick={() => {
    const draft = parseReceiptText("Cafe\n2026-10-20\nTea 8.00\nTotal XLM 8.00", 99);
    Object.values(draft.fields).forEach((field) => { field.reviewed = true; });
    draft.lineItems.forEach((line) => { line.description.reviewed = true; line.amount.reviewed = true; });
    draft.lineItemsReviewed = true;
    onUse(draft, original);
  }}>Apply fixture reviewed draft</button> }));
jest.mock("framer-motion", () => ({ AnimatePresence: ({ children }: { children: React.ReactNode }) => children,
  motion: { div: ({ children }: { children: React.ReactNode }) => <div>{children}</div> } }));
const members = [{ id: "a", name: "Alice" }, { id: "b", name: "Bob" }];
beforeEach(() => { jest.clearAllMocks(); process.env.NEXT_PUBLIC_RECEIPT_OCR_ENABLED = "true"; });
afterEach(() => { delete process.env.NEXT_PUBLIC_RECEIPT_OCR_ENABLED; });
test("blocks submit during review and creates once before attaching the original", async () => {
  jest.mocked(attachReceiptOriginal).mockResolvedValue({ status: "active" } as ExpenseReceipt);
  const done = jest.fn();
  const { container } = render(<ExpenseForm defaultMembers={members} onSuccess={done} />);
  fireEvent.click(screen.getByRole("button", { name: "Capture or select a receipt" }));
  fireEvent.submit(container.querySelector("form")!);
  expect(addExpense).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Apply fixture reviewed draft"));
  expect(addExpense).not.toHaveBeenCalled();
  expect((screen.getByLabelText(/Expense title/) as HTMLInputElement).value).toBe("Cafe");
  expect((screen.getByPlaceholderText("Add a short note about this expense...") as HTMLTextAreaElement).maxLength).toBe(12000);
  fireEvent.submit(container.querySelector("form")!);
  await screen.findByRole("button", { name: "Continue" });
  expect(addExpense).toHaveBeenCalledTimes(1);
  expect(addExpense.mock.calls[0][0]).toEqual(expect.objectContaining({ title: "Cafe", enteredAmount: "8.00", description: "Receipt date: 2026-10-20\nTea: 8.00 XLM" }));
  expect(attachReceiptOriginal).toHaveBeenCalledWith(addExpense.mock.calls[0][0].id, original);
  expect(done).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(done).toHaveBeenCalledWith(addExpense.mock.calls[0][0].id));
});
test("supports explicitly disabling the local OCR entry point", () => {
  process.env.NEXT_PUBLIC_RECEIPT_OCR_ENABLED = "false";
  render(<ExpenseForm defaultMembers={members} />);
  expect(screen.queryByRole("button", { name: "Capture or select a receipt" })).toBeNull();
});
test("keeps the reviewed draft and creates nothing when private storage is unavailable", async () => {
  jest.mocked(checkReceiptStorage).mockRejectedValueOnce(new Error("storage unavailable"));
  const { container } = render(<ExpenseForm defaultMembers={members} />);
  fireEvent.click(screen.getByRole("button", { name: "Capture or select a receipt" }));
  fireEvent.click(screen.getByText("Apply fixture reviewed draft"));
  fireEvent.submit(container.querySelector("form")!);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(addExpense).not.toHaveBeenCalled();
  expect((screen.getByLabelText(/Expense title/) as HTMLInputElement).value).toBe("Cafe");
});
