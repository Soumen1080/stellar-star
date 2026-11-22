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
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { SUPPORT_PROPOSAL_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";
import { parseJsonBody } from "@/lib/api/bodyLimits";

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
  const parsedBody = await parseJsonBody(request, { route: "/api/support/actions/propose" });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;

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
  return runIdempotentMutation({
    request,
    client: client ?? null,
    key: idempotency.key,
    replayFields: ["ok", ...replayFieldsUnder("data", SUPPORT_PROPOSAL_REPLAY_FIELDS)],
    principal: `staff:${auth.staffIdentifier}`,
    payload: body,
    execute: async () => {
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
    },
  });
}
