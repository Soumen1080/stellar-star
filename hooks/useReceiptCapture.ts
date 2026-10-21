"use client";

import { useEffect, useRef, useState } from "react";
import { recognizeReceipt } from "@/lib/receipts/ocr/recognize";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";
import { validateOcrFile } from "@/lib/receipts/ocr/file";
import type { ReceiptDraft } from "@/types/receiptDraft";

export function useReceiptCapture() {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  const reset = () => {
    generation.current++;
    controller.current?.abort();
    setFile(null); setDraft(null); setError(""); setBusy(false); setProgress(0);
  };
  const select = async (selected: File) => {
    reset();
    const id = generation.current;
    try {
      await validateOcrFile(selected);
      if (id === generation.current) setFile(selected);
    } catch {
      if (id === generation.current) setError("Choose a JPEG, PNG or WebP photo up to 4 MiB. PDF/HEIC require manual entry.");
    }
  };
  const extract = async () => {
    if (!file || busy) return;
    const id = ++generation.current;
    controller.current?.abort();
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true); setProgress(0); setError(""); setDraft(null);
    try {
      const result = await recognizeReceipt(file, operation.signal, (value) => {
        if (id === generation.current) setProgress(value);
      });
      if (id === generation.current) setDraft(result);
    } catch {
      if (id === generation.current) setError("Could not read this photo. Retry, retake it, or enter the receipt fields manually.");
    } finally {
      if (id === generation.current) setBusy(false);
    }
  };
  return { file, draft, setDraft, busy, progress, error, reset, select, extract,
    manual: () => { if (file && !busy) setDraft(parseReceiptText("", 0)); } };
}
