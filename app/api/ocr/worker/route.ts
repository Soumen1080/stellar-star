/**
 * POST /api/ocr/worker — Trigger the OCR worker to process pending jobs.
 *
 * This endpoint is called by a cron job or scheduler. It processes up to
 * `batchSize` jobs per invocation and returns the results.
 *
 * Authentication: requires a worker secret (CRON_SECRET or OCR_WORKER_SECRET)
 * to prevent unauthorized job processing.
 */

import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { runOcrWorker } from "@/lib/receipts/ocr/worker";

export async function POST(request: NextRequest) {
  // ── Authentication ─────────────────────────────────────────────────────
  const authHeader = request.headers.get("authorization") ?? "";
  const expectedSecret = process.env.OCR_WORKER_SECRET ?? process.env.CRON_SECRET ?? "";

  if (!expectedSecret) {
    return NextResponse.json(
      { error: "OCR worker is not configured (no OCR_WORKER_SECRET or CRON_SECRET)." },
      { status: 503 },
    );
  }

  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  if (token !== expectedSecret) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }

  // ── Service client ─────────────────────────────────────────────────────
  const serviceClient = createServiceRoleClient();
  if (!serviceClient) {
    return NextResponse.json(
      { error: "Database service is not configured." },
      { status: 503 },
    );
  }

  // ── Run worker ─────────────────────────────────────────────────────────
  const body = await request.json().catch(() => ({}));
  const batchSize = Math.min(Number(body?.batchSize) || 10, 50);
  const workerId = `api-worker-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    const result = await runOcrWorker({
      workerId,
      serviceClient,
      maxJobs: batchSize,
      continuous: false,
    });

    return NextResponse.json({ data: result });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Worker failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
