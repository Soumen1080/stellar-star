/** @jest-environment jsdom */
import { act, renderHook } from "@testing-library/react";
import { useReceiptCapture } from "@/hooks/useReceiptCapture";
import { recognizeReceipt } from "@/lib/receipts/ocr/recognize";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";
jest.mock("@/lib/receipts/ocr/recognize", () => ({ recognizeReceipt: jest.fn() }));
jest.mock("@/lib/receipts/ocr/file", () => ({ validateOcrFile: jest.fn().mockResolvedValue(undefined) }));
const recognize = jest.mocked(recognizeReceipt);
beforeEach(() => recognize.mockReset());
test("selection alone never starts extraction; manual fallback remains unreviewed", async () => {
  const { result } = renderHook(useReceiptCapture);
  await act(async () => result.current.select(new File(["x"], "r.jpg")));
  expect(recognize).not.toHaveBeenCalled();
  expect(result.current.draft).toBeNull();
  act(() => result.current.manual());
  expect(result.current.draft?.fields.total).toEqual({ value: "", confidence: 0, reviewed: false });
});
test("discard aborts extraction and ignores its late result", async () => {
  let resolve!: (draft: ReturnType<typeof parseReceiptText>) => void;
  recognize.mockReturnValue(new Promise((done) => { resolve = done; }));
  const { result } = renderHook(useReceiptCapture);
  await act(async () => result.current.select(new File(["x"], "r.jpg")));
  let pending!: Promise<void>;
  act(() => { pending = result.current.extract(); });
  expect(result.current.busy).toBe(true);
  const signal = recognize.mock.calls[0][1];
  act(() => result.current.reset());
  expect(signal.aborted).toBe(true);
  await act(async () => { resolve(parseReceiptText("Cafe\nTotal USD 9.00", 99)); await pending; });
  expect(result.current.file).toBeNull();
  expect(result.current.draft).toBeNull();
});
test("extraction failure preserves the selected original for retry", async () => {
  recognize.mockRejectedValue(new Error("untrusted OCR error text"));
  const { result } = renderHook(useReceiptCapture);
  const file = new File(["x"], "r.jpg");
  await act(async () => result.current.select(file));
  await act(async () => result.current.extract());
  expect(result.current.file).toBe(file);
  expect(result.current.error).toContain("manually");
  expect(result.current.error).not.toContain("untrusted");
});
