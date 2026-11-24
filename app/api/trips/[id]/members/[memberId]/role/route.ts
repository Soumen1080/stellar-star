import { NextRequest, NextResponse } from "next/server";
import { setTripMemberRole } from "@/lib/supabase/queries";
import type { TripPermission, TripRole } from "@/types/trip";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { TRIP_REPLAY_FIELDS } from "@/lib/idempotency/replay";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { toPublicErrorResponse, classifyApiError } from "@/lib/api/errors";
import { appendPrivilegedAudit } from "@/lib/audit/privilegedAudit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roles = new Set<TripRole>(["owner", "organizer", "contributor", "viewer", "custom"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: sign in with your wallet." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  let body: { role?: TripRole; customPermissions?: TripPermission[] };
  const parsedBody = await parseJsonBody(request, { route: "/api/trips/[id]/members/[memberId]/role" });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;
  if (!body.role || !roles.has(body.role) ||
      (body.customPermissions !== undefined && !Array.isArray(body.customPermissions))) {
    return NextResponse.json({ error: "A valid role and optional permission list are required." }, { status: 400 });
  }

  const { id, memberId } = await params;
  const role = body.role;
  const customPermissions = body.customPermissions ?? [];
  const client = auth.ctx.db();
  return runIdempotentMutation({
    request,
    client,
    key: idempotency.key,
    replayFields: TRIP_REPLAY_FIELDS,
    principal: session.wallet_address,
    payload: { role, customPermissions },
    execute: async () => {
      try {
        const trip = await setTripMemberRole(id, memberId, role, customPermissions, client);
        await appendPrivilegedAudit(
          {
            actorWallet: session.wallet_address,
            actorRole: "owner",
            action: "trip.member.role_change",
            decision: "allow",
            targetType: "role",
            targetId: `${id}:${memberId}`,
            requestId: request.headers.get("x-request-id"),
            metadata: { tripId: id, memberId, newRole: role, customPermissions },
          },
          client
        );
        return NextResponse.json(trip, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        if (classifyApiError(error).isInternal) {
          return toPublicErrorResponse(error, {
            requestId: request.headers.get("x-request-id"),
            fallbackMessage: "Unable to change the member role.",
            route: "/api/trips/[id]/members/[memberId]/role",
            method: "PATCH",
          });
        }
        const message = error instanceof Error ? error.message : "Unable to change the member role.";
        const status = /FORBIDDEN|LAST_OWNER|MEMBER_NOT_FOUND|TRIP_NOT_FOUND/.test(message) ? 403 : 400;
        return NextResponse.json({ error: message }, { status });
      }
    },
  });
}
