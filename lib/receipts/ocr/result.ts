/**
 * OCR result persistence — confidence, provenance, parsed fields.
 *
 * Every OCR run produces an `ocr_results` row that records:
 *   - raw_text: the full text Tesseract returned
 *   - confidence: Tesseract's overall confidence (0–100)
 *   - parsed_fields: the structured ReceiptDraft.fields
 *   - line_items: the structured ReceiptDraft.lineItems
 *   - engine / engine_version / worker_id / processing_ms: provenance
 *   - reviewed: whether a human has accepted or corrected the result
 *
 * The front-end polls `GET /api/receipts/:id/ocr` until a result lands, then
 * shows ReceiptDraftReview. Only after the user reviews every field can the
 * draft be used to create an expense. The `reviewed` flag is set by
 * `POST /api/receipts/:id/ocr/review`.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import type { ReceiptDraft } from "@/types/receiptDraft";

type Client = SupabaseClient<Database>;

export interface OcrResultInput {
  jobId: string;
  receiptId: string;
  rawText: string | null;
  confidence: number | null;
  parsedFields: ReceiptDraft["fields"];
  lineItems: ReceiptDraft["lineItems"];
  engine: string;
  engineVersion: string | null;
  workerId: string;
  processingMs: number;
}

export interface OcrResult {
  id: string;
  jobId: string;
  receiptId: string;
  rawText: string | null;
  confidence: number | null;
  parsedFields: Record<string, unknown>;
  lineItems: Array<Record<string, unknown>>;
  engine: string;
  engineVersion: string | null;
  workerId: string | null;
  processingMs: number | null;
  reviewed: boolean;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

export class OcrResultError extends Error {
  readonly status: number;
  constructor(message: string, status = 500) {
    super(message);
    this.name = "OcrResultError";
    this.status = status;
  }
}

function rowToResult(row: Record<string, unknown>): OcrResult {
  return {
    id: row.id as string,
    jobId: row.job_id as string,
    receiptId: row.receipt_id as string,
    rawText: (row.raw_text as string) ?? null,
    confidence: (row.confidence as number) ?? null,
    parsedFields: (row.parsed_fields as Record<string, unknown>) ?? {},
    lineItems: (row.line_items as Array<Record<string, unknown>>) ?? [],
    engine: row.engine as string,
    engineVersion: (row.engine_version as string) ?? null,
    workerId: (row.worker_id as string) ?? null,
    processingMs: (row.processing_ms as number) ?? null,
    reviewed: (row.reviewed as boolean) ?? false,
    reviewedAt: (row.reviewed_at as string) ?? null,
    reviewedBy: (row.reviewed_by as string) ?? null,
    createdAt: row.created_at as string,
  };
}

/**
 * Persist the result of an OCR run.
 */
export async function saveOcrResult(
  serviceClient: Client,
  input: OcrResultInput,
): Promise<OcrResult> {
  const { data, error } = await serviceClient
    .from("ocr_results")
    .insert({
      job_id: input.jobId,
      receipt_id: input.receiptId,
      raw_text: input.rawText,
      confidence: input.confidence,
      parsed_fields: input.parsedFields as unknown as Record<string, unknown>,
      line_items: input.lineItems as unknown as Array<Record<string, unknown>>,
      engine: input.engine,
      engine_version: input.engineVersion,
      worker_id: input.workerId,
      processing_ms: input.processingMs,
    })
    .select("*")
    .single();

  if (error || !data) {
    throw new OcrResultError("Could not save the OCR result.");
  }
  return rowToResult(data as Record<string, unknown>);
}

/**
 * Get the most recent OCR result for a receipt.
 */
export async function getOcrResult(
  client: Client,
  receiptId: string,
): Promise<OcrResult | null> {
  const { data, error } = await client
    .from("ocr_results")
    .select("*")
    .eq("receipt_id", receiptId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new OcrResultError("Could not load the OCR result.");
  if (!data) return null;
  return rowToResult(data as Record<string, unknown>);
}

/**
 * Mark an OCR result as reviewed. Only the wallet that uploaded the receipt
 * or created the expense may review it. This is verified in the route.
 */
export async function markOcrResultReviewed(
  serviceClient: Client,
  resultId: string,
  wallet: string,
): Promise<OcrResult> {
  const { data, error } = await serviceClient
    .from("ocr_results")
    .update({
      reviewed: true,
      reviewed_at: new Date().toISOString(),
      reviewed_by: wallet,
    })
    .eq("id", resultId)
    .select("*")
    .single();

  if (error || !data) {
    throw new OcrResultError("Could not mark the OCR result as reviewed.");
  }
  return rowToResult(data as Record<string, unknown>);
}
