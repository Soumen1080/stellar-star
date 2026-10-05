import { NextRequest, NextResponse } from "next/server";
import { createServerAnonClient } from "@/lib/supabase/server";
import { verifyTripInvite } from "@/lib/invitations/claim";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");
  const tripId = request.nextUrl.searchParams.get("tripId") || undefined;

  if (!token || token.trim() === "") {
    return NextResponse.json({ error: "token parameter is required." }, { status: 400 });
  }

  try {
    const serviceClient = createServiceRoleClient();
    const summary = await verifyTripInvite(token.trim(), serviceClient ?? undefined);
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid or unrecognized invitation.";
    if (message.includes("TRIP_MISMATCH")) {
      return NextResponse.json(
        { error: message },
        { status: 403, headers: { "Cache-Control": "no-store" } },
      );
    }
    // A revoked or expired invite was a real link, so 410 Gone rather than 404 —
    // the page can tell the recipient to ask for a fresh link instead of
    // implying they mistyped the URL.
    const gone = /revoked|expired|maximum uses|no longer exists/i.test(message);
    return NextResponse.json(
      { error: message },
      { status: gone ? 410 : 404, headers: { "Cache-Control": "no-store" } },
    );
  }
}
