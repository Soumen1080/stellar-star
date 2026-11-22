/**
 * app/api/settlement/reconciliation-worker/route.ts
 *
 * Settlement reconciliation: queryable report and on-demand worker runs.
 *
 * GET:  The reconciliation report. Cron or staff callers see every wallet; a
 *       signed-in wallet sees only its own rows. Anonymous callers get 401.
 * POST: Runs one bounded, recorded worker pass. Cron secret or staff only
 *       (Issue #415); see lib/settlement/reconciliationAuth.ts.
 *
 * The scheduled run is GET /api/settlement/reconciliation-worker/cron.
 */

import { NextRequest } from "next/server";
import { getReconciliationReport, type ReportFilter } from "@/lib/settlement/reconciliationWorker";
import { authorizeReconciliationRun, resolveReconciliationActor } from "@/lib/settlement/reconciliationAuth";
import {
  reconciliationHeaders as responseHeaders,
  reconciliationRefusal as refusal,
  reconciliationUnconfigured as serviceUnavailable,
} from "@/lib/settlement/reconciliationHttp";
import {
  clampBatchSize,
  executeReconciliationRun,
  recentReconciliationRuns,
} from "@/lib/settlement/reconciliationRun";
import { createServerClientForToken, createServiceRoleClient } from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import type { ReconciliationJobStatus } from "@/types/reconciliation";
import { parseJsonBody, limitedJson, responseLimitFor } from "@/lib/api/bodyLimits";

/** Every JSON response here is size-capped (#418). */
const respond = (body: unknown, init?: ResponseInit) =>
  limitedJson(body, init, responseLimitFor("/api/settlement/reconciliation-worker"));

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const auth = resolveReconciliationActor(request);
  if (!auth.ok) return refusal(auth, requestId);
  const { actor } = auth;

  const { searchParams } = new URL(request.url);
  const limit = Math.min(Math.max(Number(searchParams.get("limit") ?? 50) || 50, 1), 200);
  const offset = Math.max(Number(searchParams.get("offset") ?? 0) || 0, 0);
  const filter: ReportFilter = {
    status: (searchParams.get("status") ?? undefined) as ReconciliationJobStatus | "all" | "pending" | undefined,
    wallet: searchParams.get("wallet") ?? undefined,
    txHash: searchParams.get("txHash") ?? undefined,
    tripId: searchParams.get("tripId") ?? undefined,
    escalatedOnly: searchParams.get("escalatedOnly") === "true",
    limit,
    offset,
  };

  try {
    let client;
    if (actor.kind === "wallet") {
      // A wallet sees its own reconciliation only: its RLS-bound client, and
      // the wallet filter pinned to itself whatever the query string says.
      client = createServerClientForToken(actor.token!);
      filter.wallet = actor.wallet;
    } else {
      client = createServiceRoleClient();
      if (!client) return serviceUnavailable(requestId);
    }

    const report = await getReconciliationReport(filter, client);
    return respond(
      {
        ok: true,
        requestId,
        ...report,
        ...(actor.kind === "wallet" ? {} : { recentRuns: recentReconciliationRuns(10) }),
      },
      { status: 200, headers: responseHeaders(requestId) },
    );
  } catch (err) {
    console.error(
      `[reconciliation:report] ${JSON.stringify({ requestId, message: err instanceof Error ? err.message : String(err) })}`,
    );
    return respond(
      { ok: false, error: "Failed to load the reconciliation report.", code: "RECONCILIATION_REPORT_FAILED", requestId },
      { status: 500, headers: responseHeaders(requestId) },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const auth = authorizeReconciliationRun(request);
  if (!auth.ok) return refusal(auth, requestId);

  let body: { batchSize?: unknown; walletAddress?: unknown } = {};
  const parsedBody = await parseJsonBody(request, { route: "/api/settlement/reconciliation-worker", requestId, allowEmpty: true });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value ?? {}) as typeof body;

  const client = createServiceRoleClient();
  if (!client) return serviceUnavailable(requestId);

  const { record, errors } = await executeReconciliationRun({
    actor: auth.actor,
    requestId,
    trigger: auth.actor.kind === "cron" ? "schedule" : "manual",
    client,
    batchSize: clampBatchSize(body.batchSize ?? undefined),
    walletAddress: typeof body.walletAddress === "string" ? body.walletAddress : null,
  });

  return respond(
    {
      ok: record.outcome === "succeeded",
      requestId,
      run: record,
      result: {
        processed: record.processed,
        recorded: record.recorded,
        escalated: record.escalated,
        pending: record.pending,
        failed: record.failed,
        durationMs: record.durationMs,
        errors,
      },
    },
    { status: record.outcome === "succeeded" ? 200 : 500, headers: responseHeaders(requestId) },
  );
}
