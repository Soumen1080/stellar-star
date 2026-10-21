import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { executeAccountDeletion } from "@/lib/privacy/accountDeletion";

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

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = createServiceRoleClient() ?? createServerClientForToken(token);
    const result = await executeAccountDeletion(session.wallet_address, client);
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (err: any) {
    console.error("[account/delete] Failed to delete account:", err);
    return NextResponse.json(
      { error: err.message || "Failed to execute account deletion." },
      { status: 500 }
    );
  }
}

export const DELETE = POST;
