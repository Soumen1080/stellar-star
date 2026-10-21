import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const token = (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!token || !verifyWalletSession(token)) {
    return NextResponse.json({ error: "Unauthorized: sign in with your wallet." }, { status: 401 });
  }

  const { id } = await params;
  const { data, error } = await createServerClientForToken(token)
    .from("trip_role_audit")
    .select("id, trip_id, member_id, previous_role, next_role, previous_custom_permissions, next_custom_permissions, changed_by_wallet, created_at")
    .eq("trip_id", id)
    .order("created_at", { ascending: false })
    .limit(50);

  if (error) {
    return NextResponse.json({ error: "Unable to load this trip's role history." }, { status: 500 });
  }
  return NextResponse.json({ data: data ?? [] }, { headers: { "Cache-Control": "no-store" } });
}
