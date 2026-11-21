import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { revokeTripInvite } from "@/lib/invitations/claim";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";

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

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

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
    const serverClient = createServerClientForToken(token);
    return await runIdempotentMutation({
      request,
      client: serverClient,
      key: idempotency.key,
      principal: session.wallet_address,
      payload: { inviteId: body.inviteId },
      execute: async () => {
        await revokeTripInvite(body.inviteId!, session.wallet_address, serverClient);
        return NextResponse.json({ success: true }, { headers: { "Cache-Control": "no-store" } });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to revoke invitation.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
