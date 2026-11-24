import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { executeAccountDeletion } from "@/lib/privacy/accountDeletion";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { toPublicErrorResponse } from "@/lib/api/errors";

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
    const client = createServiceRoleClient() ?? auth.ctx.db();
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
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.ctx.requestId,
      fallbackMessage: "Failed to execute account deletion.",
      route: "/api/account/delete",
      method: "POST",
    });
  }
}

export const DELETE = POST;
