/**
 * app/api/support/actions/route.ts
 *
 * List Dual-Control Corrective Actions (Issue #314).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { listCorrectiveActions } from "@/lib/support/dualControl";
import { type CorrectiveActionStatus } from "@/lib/support/types";
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
  const status = searchParams.get("status") as CorrectiveActionStatus | null;
  const limit = parseInt(searchParams.get("limit") || "20", 10);

  const client = getClient();
  const actions = await listCorrectiveActions(status || undefined, limit, client as any);

  return NextResponse.json(
    { ok: true, data: actions },
    { headers: { "Cache-Control": "no-store" } }
  );
}
