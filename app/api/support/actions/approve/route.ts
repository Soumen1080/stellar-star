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
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { SUPPORT_PROPOSAL_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";

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

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

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
  // A retry of an approval that executed replays its result rather than
  // failing the "already approved" dual-control check.
  return runIdempotentMutation({
    request,
    client: client ?? null,
    key: idempotency.key,
    replayFields: ["ok", ...replayFieldsUnder("data", SUPPORT_PROPOSAL_REPLAY_FIELDS)],
    principal: `staff:${auth.staffIdentifier}`,
    payload: { proposalId, approver: effectiveApprover },
    execute: async () => {
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
    },
  });
}
