import { NextRequest, NextResponse } from "next/server";
import { generateScopedToken, listTokensForWallet } from "@/lib/api/tokens";
import { decodeClaims } from "@/lib/supabase/session";
import type { ApiScope } from "@/lib/api/types";

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

  // Also check header or query in sandbox/local dev
  const headerWallet = request.headers.get("x-wallet-address");
  if (headerWallet) return headerWallet.trim().toUpperCase();

  return null;
}

export async function GET(request: NextRequest) {
  const wallet = getWalletFromRequest(request);
  if (!wallet) {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Wallet authentication required.", status: 401 } },
      { status: 401 }
    );
  }

  const tokens = listTokensForWallet(wallet);
  return NextResponse.json({ data: tokens });
}

export async function POST(request: NextRequest) {
  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body.", status: 400 } },
      { status: 400 }
    );
  }

  const wallet = getWalletFromRequest(request) || body.wallet_address;
  if (!wallet || typeof wallet !== "string") {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Wallet address is required.", status: 401 } },
      { status: 401 }
    );
  }

  const name = body.name || "Developer Integration Token";
  const scopes: ApiScope[] = Array.isArray(body.scopes) && body.scopes.length > 0
    ? body.scopes
    : ["trips:read", "expenses:read"];
  const expiresInDays = body.expires_in_days !== undefined ? Number(body.expires_in_days) : 90;

  try {
    const { token, record } = generateScopedToken({
      walletAddress: wallet,
      name,
      scopes,
      expiresInDays,
    });

    return NextResponse.json(
      {
        data: {
          token, // Returned in full ONLY on creation
          ...record,
        },
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to create scoped token.";
    return NextResponse.json(
      { error: { code: "TOKEN_CREATION_FAILED", message, status: 400 } },
      { status: 400 }
    );
  }
}
