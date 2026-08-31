import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { claimTripInvite } from "@/lib/invitations/claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet before claiming a slot." },
      { status: 401 },
    );
  }

  let body: {
    token?: string;
    selectedMemberId?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body.token || typeof body.token !== "string") {
    return NextResponse.json({ error: "Invitation token is required." }, { status: 400 });
  }

  try {
    const result = await claimTripInvite(
      body.token,
      session.wallet_address,
      body.selectedMemberId,
    );

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to claim invitation.";
    const status = message.includes("SLOT_ALREADY_CLAIMED") ? 409 : 400;
    return NextResponse.json({ error: message }, { status });
  }
}
