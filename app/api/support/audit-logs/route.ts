/**
 * app/api/support/audit-logs/route.ts
 *
 * Staff Support Lookup Audit Log Query API (Issue #314).
 *
 * Allows authorized staff and compliance reviewers to inspect recent
 * customer support lookups and data access events.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization, fetchSupportAuditLogs } from "@/lib/support/service";
import { createServiceRoleClient, createServerAnonClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClient() {
  if (!isServerSupabaseConfigured()) return undefined;
  try {
    return createServiceRoleClient() ?? createServerAnonClient();
  } catch {
    return undefined;
  }
}

export async function GET(request: NextRequest) {
  const auth = checkStaffAuthorization(request);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: "Unauthorized: Access restricted to authorized support staff.", code: "STAFF_AUTH_REQUIRED" },
      { status: 403 }
    );
  }

  const { searchParams } = new URL(request.url);
  const limit = parseInt(searchParams.get("limit") || "50", 10);

  const client = getClient();
  const logs = await fetchSupportAuditLogs(limit, client as any);

  return NextResponse.json(
    { ok: true, data: logs },
    { headers: { "Cache-Control": "no-store" } }
  );
}
