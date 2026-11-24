/**
 * app/api/settlement/reconciliation-worker/cron/route.ts
 *
 * Scheduled settlement reconciliation (Issue #415). Vercel Cron calls this
 * with `Authorization: Bearer $CRON_SECRET` (see vercel.json); nothing else is
 * accepted, and the route is disabled (401) when CRON_SECRET is unset.
 *
 * Each invocation is one bounded, recorded run: at most
 * RECONCILIATION_MAX_BATCHES batches of RECONCILIATION_DEFAULT_BATCH_SIZE
 * jobs within RECONCILIATION_RUN_TIME_BUDGET_MS.
 */

import { NextRequest, NextResponse } from "next/server";
import { authorizeReconciliationCron } from "@/lib/settlement/reconciliationAuth";
import { executeReconciliationRun } from "@/lib/settlement/reconciliationRun";
import {
  reconciliationHeaders,
  reconciliationRefusal,
  reconciliationUnconfigured,
} from "@/lib/settlement/reconciliationHttp";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const auth = authorizeReconciliationCron(request);
  if (!auth.ok) return reconciliationRefusal(auth, requestId);

  const client = createServiceRoleClient();
  if (!client) return reconciliationUnconfigured(requestId);

  const { record } = await executeReconciliationRun({
    actor: auth.actor,
    requestId,
    trigger: "schedule",
    client,
  });

  return NextResponse.json(
    { ok: record.outcome === "succeeded", requestId, run: record },
    { status: record.outcome === "succeeded" ? 200 : 500, headers: reconciliationHeaders(requestId) },
  );
}
