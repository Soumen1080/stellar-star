import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { setTripMemberRole } from "@/lib/supabase/queries";
import type { TripPermission, TripRole } from "@/types/trip";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roles = new Set<TripRole>(["owner", "organizer", "contributor", "viewer", "custom"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  const session = token ? verifyWalletSession(token) : null;
  if (!session) {
    return NextResponse.json({ error: "Unauthorized: sign in with your wallet." }, { status: 401 });
  }

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  let body: { role?: TripRole; customPermissions?: TripPermission[] };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body.role || !roles.has(body.role) ||
      (body.customPermissions !== undefined && !Array.isArray(body.customPermissions))) {
    return NextResponse.json({ error: "A valid role and optional permission list are required." }, { status: 400 });
  }

  const { id, memberId } = await params;
  const role = body.role;
  const customPermissions = body.customPermissions ?? [];
  const client = createServerClientForToken(token);
  return runIdempotentMutation({
    request,
    client,
    key: idempotency.key,
    principal: session.wallet_address,
    payload: { role, customPermissions },
    execute: async () => {
      try {
        const trip = await setTripMemberRole(id, memberId, role, customPermissions, client);
        return NextResponse.json(trip, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to change the member role.";
        const status = /FORBIDDEN|LAST_OWNER|MEMBER_NOT_FOUND|TRIP_NOT_FOUND/.test(message) ? 403 : 400;
        return NextResponse.json({ error: message }, { status });
      }
    },
  });
}
