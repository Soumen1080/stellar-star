import { NextRequest, NextResponse } from "next/server";
import { revokeToken } from "@/lib/api/tokens";
import { decodeClaims } from "@/lib/supabase/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getWalletFromRequest(request: NextRequest): string | null {
  const authHeader = request.headers.get("authorization");
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const raw = authHeader.slice(7).trim();
    const claims = decodeClaims(raw);
    if (claims?.wallet_address) {
      return claims.wallet_address.toUpperCase();
    }
  }

  const headerWallet = request.headers.get("x-wallet-address");
  if (headerWallet) return headerWallet.trim().toUpperCase();

  return null;
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const wallet = getWalletFromRequest(request);
  if (!wallet) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Wallet authentication required.", status: 401 } },
      { status: 401 }
    );
  }

  const { id } = await params;
  const revoked = revokeToken(id, wallet);

  if (!revoked) {
    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Token not found or not owned by authenticated wallet.",
          status: 404,
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, message: "Token successfully revoked." });
}
