import { webcrypto } from "node:crypto";
import { File } from "node:buffer";
import { attachReceiptOriginal } from "@/lib/receipts/ocr/attachOriginal";
import { listExpenseReceipts, uploadExpenseReceipt, ReceiptRequestError } from "@/lib/receipts/client";
import type { ExpenseReceipt } from "@/types/receipt";
jest.mock("@/lib/receipts/client", () => ({
  ...jest.requireActual("@/lib/receipts/client"), listExpenseReceipts: jest.fn(), uploadExpenseReceipt: jest.fn(),
}));
const upload = jest.mocked(uploadExpenseReceipt);
const list = jest.mocked(listExpenseReceipts);
const file = new File(["original"], "r.jpg") as unknown as globalThis.File;
beforeEach(() => { jest.clearAllMocks(); Object.defineProperty(globalThis, "crypto", { value: webcrypto, configurable: true }); });
test("sends the exact original object and name without preparing or compressing", async () => {
  const stored = { status: "active" } as ExpenseReceipt;
  upload.mockResolvedValue(stored);
  expect(await attachReceiptOriginal("e", file)).toBe(stored);
  expect(upload).toHaveBeenCalledWith("e", file, "r.jpg", "");
});
test("accepts a lost successful response only when stored bytes match", async () => {
  upload.mockRejectedValue(new ReceiptRequestError("duplicate", 409));
  const checksum = Buffer.from(await webcrypto.subtle.digest("SHA-256", await file.arrayBuffer())).toString("hex");
  const stored = { status: "quarantined", checksum } as ExpenseReceipt;
  list.mockResolvedValue([stored]);
  expect(await attachReceiptOriginal("e", file)).toBe(stored);
});
test("does not mistake quota conflicts or removed receipts for success", async () => {
  upload.mockRejectedValue(new ReceiptRequestError("quota", 409));
  list.mockResolvedValue([{ checksum: "different", status: "active" } as ExpenseReceipt]);
  await expect(attachReceiptOriginal("e", file)).rejects.toThrow("quota");
});
