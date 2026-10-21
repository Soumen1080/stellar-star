import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { transferTripOwnership } from "@/lib/supabase/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyWalletSession(token)) {
    return NextResponse.json({ error: "Unauthorized: sign in with your wallet." }, { status: 401 });
  }

  let body: { memberId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  if (!body || typeof body.memberId !== "string" || !body.memberId.trim()) {
    return NextResponse.json({ error: "A new owner memberId is required." }, { status: 400 });
  }

  const { id } = await params;
  try {
    const trip = await transferTripOwnership(id, body.memberId, createServerClientForToken(token));
    return NextResponse.json(trip);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unable to transfer trip ownership.";
    const status = /FORBIDDEN/.test(message)
      ? 403
      : /TRIP_NOT_FOUND|MEMBER_NOT_FOUND/.test(message)
        ? 404
        : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
