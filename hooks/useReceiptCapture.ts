"use client";

import { useEffect, useRef, useState } from "react";
import { recognizeReceipt } from "@/lib/receipts/ocr/recognize";
import { parseReceiptText } from "@/lib/receipts/ocr/parser";
import { validateOcrFile } from "@/lib/receipts/ocr/file";
import {
  enqueueOcr,
  waitForOcrResult,
  OcrClientError,
} from "@/lib/receipts/ocr/ocrClient";
import { suggestion, type ReceiptDraft, type ReceiptSuggestion } from "@/types/receiptDraft";

/** Convert a server-side OCR result back into a ReceiptDraft for review. */
function ocrResultToDraft(result: {
  parsedFields: Record<string, unknown>;
  lineItems: Array<Record<string, unknown>>;
  confidence: number | null;
}): ReceiptDraft {
  const confidence = result.confidence ?? 0;
  const fields = result.parsedFields ?? {};
  const toSuggestion = (field: unknown): ReceiptSuggestion => {
    if (field && typeof field === "object" && "value" in field) {
      const f = field as { value?: string; confidence?: number; reviewed?: boolean };
      return {
        value: String(f.value ?? ""),
        confidence: Number(f.confidence ?? confidence),
        reviewed: f.reviewed === true,
      };
    }
    return suggestion("", confidence);
  };

  return {
    fields: {
      merchant: toSuggestion((fields as Record<string, unknown>).merchant),
      date: toSuggestion((fields as Record<string, unknown>).date),
      total: toSuggestion((fields as Record<string, unknown>).total),
      currency: toSuggestion((fields as Record<string, unknown>).currency),
    },
    lineItems: Array.isArray(result.lineItems)
      ? result.lineItems.map((item, i) => ({
          id: (item.id as string) ?? `ocr-${i}`,
          description: toSuggestion(item.description),
          amount: toSuggestion(item.amount),
        }))
      : [],
    lineItemsReviewed: false,
  };
}

type OcrMode = "server" | "device";

export function useReceiptCapture() {
  const [file, setFile] = useState<File | null>(null);
  const [draft, setDraft] = useState<ReceiptDraft | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [ocrMode, setOcrMode] = useState<OcrMode>("server");
  const [receiptId, setReceiptId] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; controller.current?.abort(); }, []);

  const reset = () => {
    generation.current++;
    controller.current?.abort();
    setFile(null); setDraft(null); setError(""); setBusy(false); setProgress(0);
    setReceiptId(null);
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

  /**
   * Extract fields via server-side OCR worker (the new quota-controlled path).
   * Requires the receipt to have been uploaded first (receiptId must be set).
   */
  const extractServer = async (uploadedReceiptId?: string) => {
    const rid = uploadedReceiptId ?? receiptId;
    if (!file || busy || !rid) return;
    const id = ++generation.current;
    controller.current?.abort();
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true); setProgress(0); setError(""); setDraft(null); setOcrMode("server");
    try {
      await enqueueOcr(rid);
      if (id !== generation.current) return;
      setProgress(10);

      const result = await waitForOcrResult(
        rid,
        operation.signal,
        (status) => {
          if (id === generation.current) {
            const pMap: Record<string, number> = { pending: 20, leased: 40, processing: 60 };
            setProgress(pMap[status] ?? 50);
          }
        },
      );

      if (id === generation.current) {
        setDraft(ocrResultToDraft(result));
        setProgress(100);
      }
    } catch (err) {
      if (id === generation.current) {
        if (err instanceof OcrClientError && err.status === 429) {
          setError(err.message);
        } else {
          setError("Could not read this photo. Retry, retake it, or enter the receipt fields manually.");
        }
      }
    } finally {
      if (id === generation.current) setBusy(false);
    }
  };

  /**
   * Extract fields on-device (the original path, kept as a fallback).
   */
  const extractDevice = async () => {
    if (!file || busy) return;
    const id = ++generation.current;
    controller.current?.abort();
    const operation = new AbortController();
    controller.current = operation;
    setBusy(true); setProgress(0); setError(""); setDraft(null); setOcrMode("device");
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

  const extract = async (uploadedReceiptId?: string) => {
    const rid = uploadedReceiptId ?? receiptId;
    if (rid) {
      return extractServer(rid);
    }
    return extractDevice();
  };

  return {
    file, draft, setDraft, busy, progress, error, ocrMode, receiptId,
    setReceiptId,
    reset, select,
    extract,
    extractDevice,
    extractServer,
    manual: () => { if (file && !busy) setDraft(parseReceiptText("", 0)); },
  };
}
