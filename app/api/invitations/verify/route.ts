import { NextRequest, NextResponse } from "next/server";
import { verifyTripInvite } from "@/lib/invitations/claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const token = request.nextUrl.searchParams.get("token");

  if (!token || token.trim() === "") {
    return NextResponse.json({ error: "token parameter is required." }, { status: 400 });
  }

  try {
    const summary = await verifyTripInvite(token.trim());
    return NextResponse.json(summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid or unrecognized invitation.";
    return NextResponse.json({ error: message }, { status: 404 });
  }
}
