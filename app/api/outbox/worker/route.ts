/**
 * app/api/outbox/worker/route.ts
 *
 * Leased Transactional Outbox Worker Endpoint (#425 / Issue 017).
 *
 * GET: Returns summary counts and health status of the outbox queue.
 * POST: Leases and processes a batch of due/failed outbox rows with deduplication,
 *       exponential backoff, and trace ID propagation.
 *
 * Both are cron-only (#419): `Authorization: Bearer $CRON_SECRET`, compared in
 * constant time, and disabled (401) when CRON_SECRET is unset. The worker runs
 * on the service-role client. The bearer is a secret, not a wallet session, so
 * it is never turned into a database client.
 */

import { timingSafeEqual } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { runOutboxWorkerBatch } from "@/lib/outbox/worker";
import { listOutboxEvents } from "@/lib/outbox/repository";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { toPublicErrorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isAuthorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false; // Disabled until a cron secret is configured.

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

  if (!isAuthorized(request)) {
    return NextResponse.json(
      { error: "Unauthorized outbox worker request.", requestId },
      { status: 401, headers: responseHeaders(requestId) }
    );
  }

  try {
    const client = createServiceRoleClient();

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
    return toPublicErrorResponse(err, {
      requestId,
      fallbackMessage: "Failed to query outbox queue.",
      route: "/api/outbox/worker",
      method: "GET",
    });
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
  const parsedBody = await parseJsonBody(request, { route: "/api/outbox/worker", requestId, allowEmpty: true });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value ?? {}) as typeof body;

  try {
    const client = createServiceRoleClient();

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
    return toPublicErrorResponse(err, {
      requestId,
      fallbackMessage: "Outbox worker execution failed.",
      route: "/api/outbox/worker",
      method: "POST",
    });
  }
}
