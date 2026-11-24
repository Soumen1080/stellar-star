/**
 * lib/settlement/reconciliationHttp.ts
 *
 * Response helpers shared by the reconciliation routes (Issue #415).
 */

import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import type { ReconciliationAuthResult } from "./reconciliationAuth";

export function reconciliationHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  };
}

export function reconciliationRefusal(
  result: Extract<ReconciliationAuthResult, { ok: false }>,
  requestId: string,
): NextResponse {
  return NextResponse.json(
    { ok: false, error: result.message, code: result.code, requestId },
    { status: result.status, headers: reconciliationHeaders(requestId) },
  );
}

export function reconciliationUnconfigured(requestId: string): NextResponse {
  return NextResponse.json(
    {
      ok: false,
      error: "Reconciliation requires SUPABASE_SERVICE_ROLE_KEY on this deployment.",
      code: "RECONCILIATION_UNCONFIGURED",
      requestId,
    },
    { status: 503, headers: reconciliationHeaders(requestId) },
  );
}
