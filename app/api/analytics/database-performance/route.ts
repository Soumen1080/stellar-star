import { NextRequest, NextResponse } from "next/server";
import {
  getDatabaseObservabilityReport,
  simulateDatabaseQuery,
  recordQueryTrace,
  DEFAULT_ROUTE_BUDGETS,
  type QueryTraceStatus,
} from "@/lib/supabase/queryBudget";
import { parseJsonBody } from "@/lib/api/bodyLimits";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/analytics/database-performance
 * Returns real-time database observability report:
 *  - Overall metrics (total calls, requests, avg/p95 latency, timeout & error counts)
 *  - Route performance breakdown with budget comparisons (slow/chatty flags)
 *  - Recent sanitized query traces
 */
export async function GET() {
  const report = getDatabaseObservabilityReport();

  return NextResponse.json(
    {
      overall: report.overall,
      routes: report.routes,
      recentTraces: report.recentTraces.slice(0, 50),
      budgets: DEFAULT_ROUTE_BUDGETS,
      timestamp: report.timestamp,
    },
    {
      headers: {
        "Cache-Control": "no-store, max-age=0",
      },
    }
  );
}

/**
 * POST /api/analytics/database-performance
 * Executes simulated query scenarios (fast, slow, chatty, stalled timeout)
 * or records custom telemetry traces.
 */
export async function POST(request: NextRequest) {
  try {
    const parsedBody = await parseJsonBody<Record<string, any>>(request, { route: "/api/analytics/database-performance", allowEmpty: true });
    if (!parsedBody.ok) return parsedBody.response;
    const body = parsedBody.value ?? {};
    const {
      simulate = false,
      route = "/api/trips",
      operation = "trips.select",
      table = "trips",
      delayMs = 50,
      shouldTimeout = false,
      shouldError = false,
      queryCount = 1,
    } = body;

    if (simulate) {
      const result = await simulateDatabaseQuery({
        route,
        operation,
        table,
        delayMs,
        shouldTimeout,
        shouldError,
        queryCount,
      });

      return NextResponse.json({
        success: result.success,
        trace: result.trace,
        error: result.error,
        updatedReport: getDatabaseObservabilityReport(),
      });
    }

    // Direct trace record ingestion
    if (body.requestId && body.route) {
      const trace = recordQueryTrace({
        route: String(body.route),
        requestId: String(body.requestId),
        operation: String(body.operation || "custom.query"),
        table: String(body.table || "unknown"),
        durationMs: Number(body.durationMs || 0),
        queryCount: Number(body.queryCount || 1),
        rowsCount: Number(body.rowsCount || 0),
        status: (body.status as QueryTraceStatus) || "ok",
        errorCode: body.errorCode ? String(body.errorCode) : undefined,
        statementTimeoutMs: Number(body.statementTimeoutMs || 2500),
      });

      return NextResponse.json({ success: true, trace });
    }

    return NextResponse.json(
      { error: "Invalid request payload. Must specify simulate=true or provide trace details." },
      { status: 400 }
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to process database performance request.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
