/** @jest-environment jsdom */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ReceiptCapture } from "@/components/expenses/ReceiptCapture";
import { recognizeReceipt } from "@/lib/receipts/ocr/recognize";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";
jest.mock("@/lib/receipts/ocr/recognize", () => ({ recognizeReceipt: jest.fn() }));
jest.mock("@/lib/receipts/ocr/file", () => ({ OCR_ACCEPT: "image/jpeg,image/png,image/webp", validateOcrFile: jest.fn().mockResolvedValue(undefined) }));
beforeEach(() => {
  jest.clearAllMocks();
  URL.createObjectURL = jest.fn().mockReturnValue("blob:receipt-preview");
  URL.revokeObjectURL = jest.fn();
});
test("selection and extraction cannot apply a draft until every field is checked", async () => {
  jest.mocked(recognizeReceipt).mockResolvedValue(parseReceiptText("Cafe\n2026-10-20\nTea 8.00\nTotal USD 8.00", 99));
  const onUse = jest.fn();
  const file = new File(["original"], "receipt.jpg", { type: "image/jpeg" });
  render(<ReceiptCapture onUse={onUse} onCancel={jest.fn()} />);
  fireEvent.change(screen.getByLabelText("Select receipt for draft"), { target: { files: [file] } });
  await screen.findByAltText("Original receipt for field review");
  expect(recognizeReceipt).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Extract fields on this device" }));
  const apply = await screen.findByRole("button", { name: "Use reviewed receipt draft" }) as HTMLButtonElement;
  expect(apply.disabled).toBe(true);
  expect(onUse).not.toHaveBeenCalled();
  screen.getAllByRole("checkbox").forEach((checkbox) => fireEvent.click(checkbox));
  fireEvent.click(apply);
  expect(onUse).toHaveBeenCalledWith(expect.objectContaining({ lineItemsReviewed: true }), file);
});
test("discard releases the original preview and does not apply a draft", async () => {
  const onUse = jest.fn(); const onCancel = jest.fn();
  render(<ReceiptCapture onUse={onUse} onCancel={onCancel} />);
  fireEvent.change(screen.getByLabelText("Capture receipt for draft"), { target: { files: [new File(["x"], "r.jpg")] } });
  await screen.findByAltText("Original receipt for field review");
  fireEvent.click(screen.getByRole("button", { name: "Discard receipt draft" }));
  await waitFor(() => expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:receipt-preview"));
  expect(onUse).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledTimes(1);
});
