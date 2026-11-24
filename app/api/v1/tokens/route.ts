import { NextRequest, NextResponse } from "next/server";
import { generateScopedToken, listTokensForWallet } from "@/lib/api/tokens";
import { decodeClaims } from "@/lib/supabase/session";
import type { ApiScope } from "@/lib/api/types";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { toPublicErrorResponse } from "@/lib/api/errors";

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
  const parsedBody = await parseJsonBody(request, { route: "/api/v1/tokens", format: "v1" });
  if (!parsedBody.ok) return parsedBody.response;
  body = parsedBody.value;

  const wallet = getWalletFromRequest(request) || body.wallet_address;
  if (!wallet || typeof wallet !== "string") {
    return NextResponse.json(
      { error: { code: "UNAUTHORIZED", message: "Wallet address is required.", status: 401 } },
      { status: 401 }
    );
  }

  // Issue #412: a valid key is required before a token is minted.
  const idempotency = requireIdempotencyKey(request, { format: "v1" });
  if (!idempotency.ok) return idempotency.response;

  const name = body.name || "Developer Integration Token";
  const scopes: ApiScope[] = Array.isArray(body.scopes) && body.scopes.length > 0
    ? body.scopes
    : ["trips:read", "expenses:read"];
  const expiresInDays = body.expires_in_days !== undefined ? Number(body.expires_in_days) : 90;

  // A retry mints nothing new; it replays the token issued the first time.
  // The response carries the raw secret, so it stays in the process-local
  // ledger (like the token store itself) and is never written to the database.
  return runIdempotentMutation({
    request,
    key: idempotency.key,
    replayFields: [
      "data.token",
      "data.tokenId",
      "data.tokenMasked",
      "data.walletAddress",
      "data.name",
      "data.scopes",
      "data.createdAt",
      "data.expiresAt",
      "data.revokedAt",
      "data.lastUsedAt",
    ],
    principal: wallet.toUpperCase(),
    payload: { name, scopes, expiresInDays },
    persist: false,
    format: "v1",
    execute: async () => {
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
          { status: 201, headers: { "Cache-Control": "no-store" } }
        );
      } catch (err: unknown) {
        return toPublicErrorResponse(err, {
          format: "v1",
          fallbackMessage: "Failed to create scoped token.",
          route: "/api/v1/tokens",
          method: "POST",
          status: 400,
          code: "TOKEN_CREATION_FAILED",
        });
      }
    },
  });
}
