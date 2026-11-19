/**
 * app/api/outbox/worker/route.ts
 *
 * Leased Transactional Outbox Worker Endpoint (#425 / Issue 017).
 *
 * GET: Returns summary counts and health status of the outbox queue.
 * POST: Leases and processes a batch of due/failed outbox rows with deduplication,
 *       exponential backoff, and trace ID propagation.
 */

import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runOutboxWorkerBatch } from "@/lib/outbox/worker";
import { listOutboxEvents } from "@/lib/outbox/repository";
import { createServerClientForToken, createServiceRoleClient } from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return true; // In dev/test allow requests

  const authHeader = request.headers.get("authorization") ?? "";
  if (!authHeader.startsWith("Bearer ")) return false;

  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(authHeader);

  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function responseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  };
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  try {
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const client = token ? createServerClientForToken(token) : createServiceRoleClient();

    const [pending, leased, delivered, failed, deadLetter] = await Promise.all([
      listOutboxEvents({ status: "pending", limit: 100 }, client ?? undefined),
      listOutboxEvents({ status: "leased", limit: 100 }, client ?? undefined),
      listOutboxEvents({ status: "delivered", limit: 100 }, client ?? undefined),
      listOutboxEvents({ status: "failed", limit: 100 }, client ?? undefined),
      listOutboxEvents({ status: "dead_letter", limit: 100 }, client ?? undefined),
    ]);

    return NextResponse.json(
      {
        ok: true,
        requestId,
        counts: {
          pending: pending.length,
          leased: leased.length,
          delivered: delivered.length,
          failed: failed.length,
          deadLetter: deadLetter.length,
        },
      },
      { headers: responseHeaders(requestId) }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to query outbox queue.";
    return NextResponse.json(
      { error: message, requestId },
      { status: 500, headers: responseHeaders(requestId) }
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized outbox worker trigger.", requestId },
      { status: 401, headers: responseHeaders(requestId) }
    );
  }

  let body: { batchSize?: number; leaseDurationSeconds?: number; workerId?: string } = {};
  try {
    body = await request.json();
  } catch {
    // Empty body is valid
  }

  try {
    const authHeader = request.headers.get("authorization") ?? "";
    const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
    const client = token ? createServerClientForToken(token) : createServiceRoleClient();

    const result = await runOutboxWorkerBatch(
      {
        workerId: body.workerId,
        batchSize: body.batchSize,
        leaseDurationSeconds: body.leaseDurationSeconds,
      },
      client ?? undefined
    );

    return NextResponse.json(
      {
        ok: true,
        requestId,
        data: result,
      },
      { headers: responseHeaders(requestId) }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Outbox worker execution failed.";
    return NextResponse.json(
      { error: message, requestId },
      { status: 500, headers: responseHeaders(requestId) }
    );
  }
}
