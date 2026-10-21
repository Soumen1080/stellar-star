/**
 * app/api/support/actions/approve/route.ts
 *
 * Approve & Execute Dual-Control Corrective Action (Issue #314).
 *
 * Enforces the Four-Eyes Principle:
 * Proposer (Staff A) !== Approver (Staff B).
 */

import { NextRequest, NextResponse } from "next/server";
import { checkStaffAuthorization } from "@/lib/support/service";
import { approveCorrectiveAction, DualControlError } from "@/lib/support/dualControl";
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

  const { proposalId, approverIdentifier } = body;
  if (!proposalId) {
    return NextResponse.json({ error: "proposalId is required.", code: "MISSING_PROPOSAL_ID" }, { status: 400 });
  }

  const effectiveApprover =
    (typeof approverIdentifier === "string" && approverIdentifier.trim())
      ? approverIdentifier.trim()
      : auth.staffIdentifier;

  const client = getClient();
  try {
    const executed = await approveCorrectiveAction(proposalId, effectiveApprover, client as any);
    return NextResponse.json(
      { ok: true, data: executed },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    if (err instanceof DualControlError) {
      return NextResponse.json({ error: err.message, code: err.code }, { status: err.status });
    }
    return NextResponse.json(
      { error: err?.message || "Failed to approve corrective action." },
      { status: 500 }
    );
  }
}
