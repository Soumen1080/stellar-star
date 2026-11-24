import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { executeAccountDeletionStateMachine } from "@/lib/privacy/accountDeletionStateMachine";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: Sign in with your wallet to delete your account." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

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
    const client = createServiceRoleClient();
    if (!client) return NextResponse.json({ error: "Account deletion service is not configured." }, { status: 503 });
    const result = await executeAccountDeletionStateMachine(session.wallet_address, client);
    return NextResponse.json(result, { status: result.state === "held" ? 202 : 200, headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("[account/delete] Failed to delete account:", err);
    return NextResponse.json(
      { error: err.message || "Failed to execute account deletion." },
      { status: 500 }
    );
  }
}

export const DELETE = POST;
