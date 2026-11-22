/**
 * app/api/settlement/reconciliation-worker/route.ts
 *
 * Settlement reconciliation: queryable report and on-demand worker runs.
 *
 * GET:  The reconciliation report. Cron or staff callers see every wallet; a
 *       signed-in wallet sees only its own rows. Anonymous callers get 401.
 * POST: Cron secret or staff only (Issue #415); see
 *       lib/settlement/reconciliationAuth.ts. The body's `action` picks:
 *         "run" (default)  one bounded, recorded, leased worker pass (#416).
 *                          Jobs are claimed FOR UPDATE SKIP LOCKED under a
 *                          heartbeated lease, so overlapping runs never share
 *                          a job, and if this request is killed by the
 *                          platform timeout its leases lapse and the next run
 *                          recovers the work.
 *         "enqueue"        copies pending settlement intents into the durable
 *                          queue and returns 202. No Horizon or RPC call
 *                          happens inside the request.
 *         "requeue"        returns one dead-lettered job (`jobId`) to the queue.
 *
 * The scheduled run is GET /api/settlement/reconciliation-worker/cron.
 */

import { NextRequest, NextResponse } from "next/server";
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
import { requeueReconciliationJob } from "@/lib/settlement/reconciliationQueue";
import { syncPendingIntentsToQueue } from "@/lib/settlement/reconciliationWorker";
import { createServerClientForToken, createServiceRoleClient } from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import type { ReconciliationJobStatus } from "@/types/reconciliation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// A run's own time budget (RECONCILIATION_RUN_TIME_BUDGET_MS) stays below this.
export const maxDuration = 60;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    return NextResponse.json(
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
    return NextResponse.json(
      { ok: false, error: "Failed to load the reconciliation report.", code: "RECONCILIATION_REPORT_FAILED", requestId },
      { status: 500, headers: responseHeaders(requestId) },
    );
  }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const auth = authorizeReconciliationRun(request);
  if (!auth.ok) return refusal(auth, requestId);

  let body: { batchSize?: unknown; walletAddress?: unknown; action?: unknown; jobId?: unknown } = {};
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) body = parsed as typeof body;
  } catch {
    // An empty body runs a default-sized pass.
  }

  const action = body.action === undefined ? "run" : body.action;
  if (action !== "run" && action !== "enqueue" && action !== "requeue") {
    return NextResponse.json(
      { ok: false, error: "action must be run, enqueue or requeue.", code: "RECONCILIATION_ACTION_INVALID", requestId },
      { status: 400, headers: responseHeaders(requestId) },
    );
  }
  if (action === "requeue" && (typeof body.jobId !== "string" || !UUID_RE.test(body.jobId))) {
    return NextResponse.json(
      { ok: false, error: "requeue needs the jobId of a dead-lettered job.", code: "RECONCILIATION_JOB_ID_INVALID", requestId },
      { status: 400, headers: responseHeaders(requestId) },
    );
  }

  const client = createServiceRoleClient();
  if (!client) return serviceUnavailable(requestId);
  const walletAddress = typeof body.walletAddress === "string" ? body.walletAddress : null;

  if (action === "enqueue") {
    try {
      const enqueued = await syncPendingIntentsToQueue(walletAddress?.trim() || undefined, client);
      console.info(
        `[reconciliation:enqueue] ${JSON.stringify({ requestId, actor: auth.actor.id, enqueued })}`,
      );
      return NextResponse.json(
        { ok: true, requestId, action, enqueued },
        { status: 202, headers: responseHeaders(requestId) },
      );
    } catch (err) {
      console.error(
        `[reconciliation:enqueue] ${JSON.stringify({ requestId, message: err instanceof Error ? err.message : String(err) })}`,
      );
      return NextResponse.json(
        { ok: false, error: "Failed to enqueue reconciliation jobs.", code: "RECONCILIATION_ENQUEUE_FAILED", requestId },
        { status: 500, headers: responseHeaders(requestId) },
      );
    }
  }

  if (action === "requeue") {
    const jobId = body.jobId as string;
    try {
      const requeued = await requeueReconciliationJob(client, jobId);
      console.info(
        `[reconciliation:requeue] ${JSON.stringify({ requestId, actor: auth.actor.id, jobId, requeued })}`,
      );
      if (!requeued) {
        return NextResponse.json(
          { ok: false, error: "No dead-lettered job with that id.", code: "RECONCILIATION_JOB_NOT_DEAD_LETTERED", requestId },
          { status: 409, headers: responseHeaders(requestId) },
        );
      }
      return NextResponse.json(
        { ok: true, requestId, action, jobId },
        { status: 202, headers: responseHeaders(requestId) },
      );
    } catch (err) {
      console.error(
        `[reconciliation:requeue] ${JSON.stringify({ requestId, message: err instanceof Error ? err.message : String(err) })}`,
      );
      return NextResponse.json(
        { ok: false, error: "Failed to requeue the reconciliation job.", code: "RECONCILIATION_REQUEUE_FAILED", requestId },
        { status: 500, headers: responseHeaders(requestId) },
      );
    }
  }

  const { record, errors } = await executeReconciliationRun({
    actor: auth.actor,
    requestId,
    trigger: auth.actor.kind === "cron" ? "schedule" : "manual",
    client,
    batchSize: clampBatchSize(body.batchSize ?? undefined),
    walletAddress,
  });

  return NextResponse.json(
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
        deadLettered: record.deadLettered,
        leaseLost: record.leaseLost,
        durationMs: record.durationMs,
        errors,
      },
    },
    { status: record.outcome === "succeeded" ? 200 : 500, headers: responseHeaders(requestId) },
  );
}
