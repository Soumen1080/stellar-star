/**
 * app/api/admin/audit/verify/route.ts
 *
 * Issue #455: Privileged Audit Verification API.
 * Verifies hash chain integrity and returns tampering detection reports.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { verifyAuditChainIntegrity, createAuditIntegrityAnchor } from "@/lib/audit/privilegedAudit";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  const staffAuth = checkStaffAuthorization(request);
  if (!staffAuth.authorized) {
    const userAuth = await authenticateWalletRequest(request);
    if (!userAuth.ok) {
      return NextResponse.json(
        { error: "Unauthorized: Access restricted to authorized operators or compliance auditors.", code: "AUTH_REQUIRED" },
        { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }
  }

  const client = isServerSupabaseConfigured() ? createServiceRoleClient() : undefined;
  const report = await verifyAuditChainIntegrity(client);

  return NextResponse.json(
    { data: report, requestId },
    { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } }
  );
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  const staffAuth = checkStaffAuthorization(request);
  if (!staffAuth.authorized) {
    const userAuth = await authenticateWalletRequest(request);
    if (!userAuth.ok) {
      return NextResponse.json(
        { error: "Unauthorized: Access restricted to authorized operators.", code: "AUTH_REQUIRED" },
        { status: 403, headers: { [REQUEST_ID_HEADER]: requestId } },
      );
    }
  }

  const client = isServerSupabaseConfigured() ? createServiceRoleClient() : undefined;
  const anchor = await createAuditIntegrityAnchor(
    {
      anchoredBy: staffAuth.authorized ? `staff:${staffAuth.staffIdentifier}` : "admin",
      metadata: { initiatedVia: "api", requestId },
    },
    client
  );

  return NextResponse.json(
    { data: anchor, requestId },
    { status: 200, headers: { [REQUEST_ID_HEADER]: requestId } }
  );
}
