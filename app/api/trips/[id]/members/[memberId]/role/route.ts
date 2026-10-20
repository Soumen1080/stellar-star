import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { setTripMemberRole } from "@/lib/supabase/queries";
import type { TripPermission, TripRole } from "@/types/trip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roles = new Set<TripRole>(["owner", "organizer", "contributor", "viewer", "custom"]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string; memberId: string }> },
) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyWalletSession(token)) {
    return NextResponse.json({ error: "Unauthorized: sign in with your wallet." }, { status: 401 });
  }

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
  try {
    const trip = await setTripMemberRole(
      id,
      memberId,
      body.role,
      body.customPermissions ?? [],
      createServerClientForToken(token),
    );
    return NextResponse.json(trip);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to change the member role.";
    const status = /FORBIDDEN|LAST_OWNER|MEMBER_NOT_FOUND|TRIP_NOT_FOUND/.test(message) ? 403 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
