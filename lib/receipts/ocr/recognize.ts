"use client";

import type { Worker } from "tesseract.js";
import { parseReceiptText } from "./parser";
import { validateOcrFile } from "./file";

export const OCR_TIMEOUT_MS = 60_000;

export async function recognizeReceipt(file: File, signal: AbortSignal, progress: (value: number) => void) {
  await validateOcrFile(file);
  if (signal.aborted) throw new Error("Receipt extraction cancelled.");
  let worker: Worker | undefined;
  let image: ImageBitmap | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let finished = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(new Error("Receipt extraction cancelled."));
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => reject(new Error("Extraction timed out. Retry or enter the fields manually.")), OCR_TIMEOUT_MS);
  });
  const work = async () => {
    const bitmap = await createImageBitmap(file);
    image = bitmap;
    try {
      if (finished || signal.aborted) throw new Error("Receipt extraction cancelled.");
      if (bitmap.width * bitmap.height > 25_000_000) throw new Error("Photo resolution is too large. Choose a smaller photo.");
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image processing is unavailable in this browser.");
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const { createWorker } = await import("tesseract.js");
      if (finished || signal.aborted) throw new Error("Receipt extraction cancelled.");
      worker = await createWorker("eng", 1, {
        workerPath: `${window.location.origin}/ocr/worker.min.js`,
        corePath: `${window.location.origin}/ocr/core`,
        langPath: `${window.location.origin}/ocr`,
        workerBlobURL: false,
        cacheMethod: "none",
        logger: ({ status, progress: fraction }) => {
          if (!finished && status === "recognizing text") progress(Math.round(fraction * 100));
        },
        errorHandler: () => {}, // Worker errors may contain OCR input: never log them.
      });
      if (finished || signal.aborted) {
        await worker.terminate();
        throw new Error("Receipt extraction cancelled.");
      }
      const { data } = await worker.recognize(canvas);
      return parseReceiptText(data.text, data.confidence);
    } finally {
      bitmap.close();
    }
  };
  try {
    return await Promise.race([work(), cancelled]);
  } finally {
    finished = true;
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    if (worker) await worker.terminate().catch(() => {});
    image?.close();
    if (canvas) { canvas.width = 0; canvas.height = 0; }
  }
}
