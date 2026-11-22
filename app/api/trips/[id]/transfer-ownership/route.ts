import { NextRequest, NextResponse } from "next/server";
import { transferTripOwnership } from "@/lib/supabase/queries";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { TRIP_REPLAY_FIELDS } from "@/lib/idempotency/replay";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: sign in with your wallet." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  let body: { memberId?: unknown };
  const parsedBody = await parseJsonBody(request, { route: "/api/trips/[id]/transfer-ownership" });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;
  if (!body || typeof body.memberId !== "string" || !body.memberId.trim()) {
    return NextResponse.json({ error: "A new owner memberId is required." }, { status: 400 });
  }

  const { id } = await params;
  const memberId = body.memberId;
  const client = auth.ctx.db();
  // A retry of a transfer that landed replays it; without the claim the
  // former owner would now fail the FORBIDDEN check.
  return runIdempotentMutation({
    request,
    client,
    key: idempotency.key,
    replayFields: TRIP_REPLAY_FIELDS,
    principal: session.wallet_address,
    payload: { memberId },
    execute: async () => {
      try {
        const trip = await transferTripOwnership(id, memberId, client);
        return NextResponse.json(trip, { headers: { "Cache-Control": "no-store" } });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unable to transfer trip ownership.";
        const status = /FORBIDDEN/.test(message)
          ? 403
          : /TRIP_NOT_FOUND|MEMBER_NOT_FOUND/.test(message)
            ? 404
            : 400;
        return NextResponse.json({ error: message }, { status });
      }
    },
  });
}
