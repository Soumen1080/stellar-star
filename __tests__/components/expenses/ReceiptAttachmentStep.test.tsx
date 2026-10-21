/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReceiptAttachmentStep } from "@/components/expenses/ReceiptAttachmentStep";
import { attachReceiptOriginal } from "@/lib/receipts/ocr/attachOriginal";
import type { ExpenseReceipt } from "@/types/receipt";

jest.mock("@/lib/receipts/ocr/attachOriginal", () => ({ attachReceiptOriginal: jest.fn() }));
const attach = jest.mocked(attachReceiptOriginal);
beforeEach(() => attach.mockReset());
test("keeps the original and existing expense for retry, then explicitly finishes", async () => {
  attach.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ status: "active" } as ExpenseReceipt);
  const onDone = jest.fn();
  const file = new File(["original bytes"], "receipt.jpg");
  render(<ReceiptAttachmentStep expenseId="existing-expense" file={file} onDone={onDone} />);
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry receipt attachment" }));
  await screen.findByRole("button", { name: "Continue" });
  expect(attach.mock.calls).toEqual([["existing-expense", file], ["existing-expense", file]]);
  fireEvent.click(screen.getByRole("button", { name: "Continue" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
});
test("explains quarantined originals", async () => {
  attach.mockResolvedValue({ status: "quarantined" } as ExpenseReceipt);
  render(<ReceiptAttachmentStep expenseId="e" file={new File(["x"], "r.jpg")} onDone={jest.fn()} />);
  expect(await screen.findByText(/Original stored in quarantine/)).toBeTruthy();
});
