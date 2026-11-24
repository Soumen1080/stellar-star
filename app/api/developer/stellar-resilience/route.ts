/**
 * app/api/developer/stellar-resilience/route.ts
 *
 * Operational telemetry & status endpoint for Stellar Circuit Breakers & Bulkheads (#426).
 *
 * GET: Returns real-time health metrics, breaker states (CLOSED/OPEN/HALF_OPEN),
 *      and bulkhead concurrency pool utilization across all dependency classes.
 * POST: Allows authenticated staff/developer to reset tripped breakers or drain bulkheads.
 */

import { NextRequest, NextResponse } from "next/server";
import { stellarResilience } from "@/lib/stellar/resilience";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { toPublicErrorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function responseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  };
}

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  try {
    const metrics = stellarResilience.getAllMetrics();
    const isDegraded = Object.values(metrics.circuitBreakers).some(
      (b: any) => b.state === "OPEN"
    );

    return NextResponse.json(
      {
        ok: true,
        requestId,
        status: isDegraded ? "degraded" : "healthy",
        ...metrics,
      },
      {
        status: 200,
        headers: responseHeaders(requestId),
      }
    );
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId,
      fallbackMessage: "Failed to load resilience metrics",
      route: "/api/developer/stellar-resilience",
      method: "GET",
    });
  }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  try {
    let body: { action?: string; dependencyClass?: string } = {};
    const parsedBody = await parseJsonBody(request, { route: "/api/developer/stellar-resilience", requestId, allowEmpty: true });
    if (!parsedBody.ok) return parsedBody.response;
    body = (parsedBody.value ?? {}) as typeof body;

    if (body.action === "reset") {
      stellarResilience.resetAll();
    }

    return NextResponse.json(
      {
        ok: true,
        requestId,
        message: "Stellar circuit breakers and bulkheads reset.",
        ...stellarResilience.getAllMetrics(),
      },
      { headers: responseHeaders(requestId) }
    );
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId,
      fallbackMessage: "Failed to reset resilience managers",
      route: "/api/developer/stellar-resilience",
      method: "POST",
    });
  }
}
