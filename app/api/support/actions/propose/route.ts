/**
 * app/api/support/actions/propose/route.ts
 *
 * Propose Dual-Control Corrective Action (Issue #314).
 *
 * Initiates a dual-control workflow for an exceptional state correction
 * requiring a secondary staff member's approval.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { proposeCorrectiveAction, DualControlError } from "@/lib/support/dualControl";
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

export async function POST(request: NextRequest) {
  const auth = checkStaffAuthorization(request);
  if (!auth.authorized) {
    return NextResponse.json(
      { error: "Unauthorized: Access restricted to authorized support staff.", code: "STAFF_AUTH_REQUIRED" },
      { status: 403 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const { actionType, targetId, targetType, ticketRef, reason, details } = body;

  if (!actionType || !targetId || !targetType || !ticketRef || !reason) {
    return NextResponse.json(
      {
        error: "Missing required fields: actionType, targetId, targetType, ticketRef, reason.",
        code: "MISSING_FIELDS",
      },
      { status: 400 }
    );
  }

  const client = getClient();
  try {
    const proposal = await proposeCorrectiveAction(
      {
        actionType,
        targetId,
        targetType,
        ticketRef,
        reason,
        details,
        proposedBy: auth.staffIdentifier,
      },
      client as any
    );

    return NextResponse.json(
      { ok: true, data: proposal },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    if (err instanceof DualControlError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json(
      { error: err?.message || "Failed to submit proposal." },
      { status: 500 }
    );
  }
}
