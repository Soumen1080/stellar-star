import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";
import { claimTripInvite } from "@/lib/invitations/claim";
import {
  extractIdempotencyKey,
  withIdempotency,
  idempotentJsonResponse,
  IdempotencyConflictError,
  IdempotencyLockedError,
} from "@/lib/idempotency/store";
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

  if (!body.token || typeof body.token !== "string") {
    return NextResponse.json({ error: "Invitation token is required." }, { status: 400 });
  }

  try {
    const serverClient = createServerClientForToken(token);
    const idempotencyKey = extractIdempotencyKey(request, body);
    const keyLimit = await enforceIdempotencyKeyLimit(request, session.wallet_address, idempotencyKey);
    if (!keyLimit.ok) return keyLimit.response;

    const result = await withIdempotency({
      client: serverClient,
      key: idempotencyKey,
      walletAddress: session.wallet_address,
      endpoint: "/api/invitations/claim",
      payload: body,
      execute: async () => {
        const claimed = await claimTripInvite(
          body.token!,
          session.wallet_address,
          body.selectedMemberId,
          serverClient,
        );
        return { data: claimed, status: 200 };
      },
    });

    return idempotentJsonResponse(result);
  } catch (err) {
    if (err instanceof IdempotencyConflictError || err instanceof IdempotencyLockedError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: 409 }
      );
    }
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
