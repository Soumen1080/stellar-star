import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createTripInvite } from "@/lib/invitations/claim";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to create invites." },
      { status: 401 },
    );
  }

  let body: {
    tripId?: string;
    memberId?: string | null;
    maxUses?: number;
    expiresInDays?: number;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  if (!body.tripId || typeof body.tripId !== "string") {
    return NextResponse.json({ error: "tripId is required." }, { status: 400 });
  }

  try {
    const origin = request.nextUrl.origin;
    const result = await createTripInvite({
      tripId: body.tripId,
      createdByWallet: session.wallet_address,
      memberId: body.memberId || null,
      maxUses: body.maxUses,
      expiresInDays: body.expiresInDays,
      baseUrl: origin,
    });

    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create invitation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
