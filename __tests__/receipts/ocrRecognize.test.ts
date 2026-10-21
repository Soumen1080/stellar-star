/** @jest-environment jsdom */
import { recognizeReceipt, OCR_TIMEOUT_MS } from "@/lib/receipts/ocr/recognize";
import { createWorker } from "tesseract.js";
jest.mock("tesseract.js", () => ({ createWorker: jest.fn() }));
jest.mock("@/lib/receipts/ocr/file", () => ({ validateOcrFile: jest.fn().mockResolvedValue(undefined) }));
const create = jest.mocked(createWorker);
const terminate = jest.fn().mockResolvedValue(undefined);
const recognize = jest.fn();
const close = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(globalThis, "createImageBitmap", { configurable: true, value: jest.fn().mockResolvedValue({ width: 800, height: 1200, close }) });
  jest.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: jest.fn() } as unknown as CanvasRenderingContext2D);
  create.mockResolvedValue({ recognize, terminate } as unknown as Awaited<ReturnType<typeof createWorker>>);
  recognize.mockResolvedValue({ data: { text: "Cafe\nTOTAL USD 12.00", confidence: 93 } });
});
afterEach(() => { jest.restoreAllMocks(); jest.useRealTimers(); });
test("uses only same-origin paths, disables persistent cache and releases resources", async () => {
  const draft = await recognizeReceipt(new File(["x"], "r.jpg"), new AbortController().signal, jest.fn());
  expect(create).toHaveBeenCalledWith("eng", 1, expect.objectContaining({
    workerPath: `${location.origin}/ocr/worker.min.js`, corePath: `${location.origin}/ocr/core`,
    langPath: `${location.origin}/ocr`, workerBlobURL: false, cacheMethod: "none",
  }));
  expect(draft.fields.total.value).toBe("12.00");
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalled();
});
test("cancels recognition and terminates the worker", async () => {
  recognize.mockReturnValue(new Promise(() => {}));
  const controller = new AbortController();
  const result = recognizeReceipt(new File(["x"], "r.jpg"), controller.signal, jest.fn());
  const assertion = expect(result).rejects.toThrow("cancelled");
  while (!recognize.mock.calls.length) await Promise.resolve();
  controller.abort();
  await assertion;
  expect(terminate).toHaveBeenCalledTimes(1);
  expect(close).toHaveBeenCalled();
});
test("bounds initialization time and cleans up a worker that initializes late", async () => {
  jest.useFakeTimers();
  let resolveWorker!: (worker: Awaited<ReturnType<typeof createWorker>>) => void;
  create.mockReturnValue(new Promise((resolve) => { resolveWorker = resolve; }));
  const result = recognizeReceipt(new File(["x"], "r.jpg"), new AbortController().signal, jest.fn());
  const assertion = expect(result).rejects.toThrow("timed out");
  while (!create.mock.calls.length) await Promise.resolve();
  await jest.advanceTimersByTimeAsync(OCR_TIMEOUT_MS);
  await assertion;
  resolveWorker({ recognize, terminate } as unknown as Awaited<ReturnType<typeof createWorker>>);
  await Promise.resolve(); await Promise.resolve();
  expect(terminate).toHaveBeenCalled();
  expect(recognize).not.toHaveBeenCalled();
});
