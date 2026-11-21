import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { claimTripInvite } from "@/lib/invitations/claim";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { enforceAbuseProtection, enforceIdempotencyKeyLimit } from "@/lib/security/abuseProtection";

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
  const abuse = await enforceAbuseProtection(request, "invitation.claim", session.wallet_address);
  if (!abuse.ok) return abuse.response;

  let body: {
    token?: string;
    selectedMemberId?: string;
    tripId?: string;
    idempotencyKey?: string;
  };

  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request, { body });
  if (!idempotency.ok) return idempotency.response;

  if (!body.token || typeof body.token !== "string") {
    return NextResponse.json({ error: "Invitation token is required." }, { status: 400 });
  }

  try {
    const serverClient = createServerClientForToken(token);
    const keyLimit = await enforceIdempotencyKeyLimit(request, session.wallet_address, idempotency.key);
    if (!keyLimit.ok) return keyLimit.response;

    return await runIdempotentMutation({
      request,
      client: serverClient,
      key: idempotency.key,
      replayFields: ["success", "tripId", "tripName", "memberId", "memberName"],
      principal: session.wallet_address,
      // Kept from the pre-#412 wrapper so keys stored before the change still match.
      endpoint: "/api/invitations/claim",
      payload: body,
      execute: async () => {
        const claimed = await claimTripInvite(
          body.token!,
          session.wallet_address,
          body.selectedMemberId,
          serverClient,
        );
        return NextResponse.json(claimed, { headers: { "Cache-Control": "no-store" } });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to claim invitation.";
    let status = 400;
    if (message.includes("SLOT_ALREADY_CLAIMED") || message.includes("WALLET_ALREADY_MEMBER")) {
      status = 409;
    } else if (message.includes("TRIP_MISMATCH") || message.includes("INVITE_MEMBER_MISMATCH")) {
      status = 403;
    } else if (/revoked|expired|maximum uses/i.test(message)) {
      status = 410;
    } else if (/not found/i.test(message)) {
      status = 404;
    }
    return NextResponse.json({ error: message }, { status });
  }
}
