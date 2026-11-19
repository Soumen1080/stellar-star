import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";

  if (!token) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to export your data." },
      { status: 401 }
    );
  }

  const session = verifyWalletSession(token);
  if (!session || !session.wallet_address) {
    return NextResponse.json(
      { error: "Invalid or expired session token." },
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
    const client = createServerClientForToken(token);
    const wallet = session.wallet_address;

    // Fetch user profile
    const { data: user } = await client
      .from("users")
      .select("*")
      .eq("wallet_address", wallet)
      .maybeSingle();

    // Fetch trips where user is member
    const { data: trips } = await client
      .from("trips")
      .select("*")
      .contains("member_wallets", [wallet]);

    // Fetch expenses where user is member
    const { data: expenses } = await client
      .from("expenses")
      .select("*")
      .contains("member_wallets", [wallet]);

    // Fetch contacts
    let contacts: unknown[] = [];
    try {
      const { data } = await client.from("contacts").select("*").eq("owner_wallet", wallet);
      contacts = data ?? [];
    } catch {
      // Non-fatal
    }

    const exportPayload = {
      version: "1.0",
      exportedAt: new Date().toISOString(),
      walletAddress: wallet,
      profile: user ?? null,
      trips: trips ?? [],
      expenses: expenses ?? [],
      contacts,
      notice:
        "This export contains your off-chain application data. Public blockchain transactions, contract calls, and signatures are recorded on the public Stellar ledger.",
    };

    return NextResponse.json(exportPayload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (err: any) {
    console.error("[account/export] Export failed:", err);
    return NextResponse.json(
      { error: err.message || "Failed to generate account export." },
      { status: 500 }
    );
  }
}
