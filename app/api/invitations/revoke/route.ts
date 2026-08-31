import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { revokeTripInvite } from "@/lib/invitations/claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to revoke invites." },
      { status: 401 },
    );
  }

  let body: {
    inviteId?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body.inviteId || typeof body.inviteId !== "string") {
    return NextResponse.json({ error: "inviteId is required." }, { status: 400 });
  }

  try {
    await revokeTripInvite(body.inviteId, session.wallet_address);
    return NextResponse.json({ success: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revoke invitation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
