import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { executeAccountDeletion } from "@/lib/privacy/accountDeletion";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to delete your account." },
      { status: 401 }
    );
  }

  const session = verifyWalletSession(token);
  if (!session || !session.wallet_address) {
    return NextResponse.json(
      { error: "Invalid or expired session token. Please sign in again." },
      { status: 401 }
    );
  }

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServiceRoleClient() ?? createServerClientForToken(token);
    return await runIdempotentMutation({
      request,
      key: idempotency.key,
      replayFields: ["success", "deletedAt", "summary"],
      principal: session.wallet_address,
      // Both verbs are the same operation, so they share one fingerprint.
      endpoint: "/api/account/delete",
      payload: {},
      // Process-local only: persisting the result would write a new row keyed
      // to the wallet that was just erased.
      persist: false,
      execute: async () => {
        const result = await executeAccountDeletion(session.wallet_address, client);
        return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
      },
    });
  } catch (err: any) {
    console.error("[account/delete] Failed to delete account:", err);
    return NextResponse.json(
      { error: err.message || "Failed to execute account deletion." },
      { status: 500 }
    );
  }
}

export const DELETE = POST;
