import { NextRequest, NextResponse } from "next/server";
import { createTripInvite } from "@/lib/invitations/claim";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { enforceAbuseProtection, enforceIdempotencyKeyLimit } from "@/lib/security/abuseProtection";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: Sign in with your wallet to create invites." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;
  const abuse = await enforceAbuseProtection(request, "invitation.create", session.wallet_address);
  if (!abuse.ok) return abuse.response;

  let body: {
    tripId?: string;
    memberId?: string | null;
    maxUses?: number;
    expiresInDays?: number;
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

  if (!body.tripId || typeof body.tripId !== "string") {
    return NextResponse.json({ error: "tripId is required." }, { status: 400 });
  }

  try {
    const origin = request.nextUrl.origin;
    const serverClient = auth.ctx.db();
    const keyLimit = await enforceIdempotencyKeyLimit(request, session.wallet_address, idempotency.key);
    if (!keyLimit.ok) return keyLimit.response;

    return await runIdempotentMutation({
      request,
      client: serverClient,
      key: idempotency.key,
      replayFields: ["inviteUrl", "invite.id", "invite.tripId", "invite.memberId", "invite.expiresAt", "invite.maxUses", "invite.uses", "invite.revoked", "invite.createdAt"],
      principal: session.wallet_address,
      // Kept from the pre-#412 wrapper so keys stored before the change still match.
      endpoint: "/api/invitations/create",
      // The invite URL carries the raw join token, so the replay stays in the
      // process-local ledger and the token is never written to the database.
      persist: false,
      payload: body,
      execute: async () => {
        const created = await createTripInvite(
          {
            tripId: body.tripId!,
            createdByWallet: session.wallet_address,
            memberId: body.memberId || null,
            maxUses: body.maxUses,
            expiresInDays: body.expiresInDays,
            baseUrl: origin,
          },
          serverClient,
        );
        return NextResponse.json(created, { headers: { "Cache-Control": "no-store" } });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create invitation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
