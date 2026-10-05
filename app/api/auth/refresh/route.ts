import { NextRequest, NextResponse } from "next/server";
import {
  refreshWalletSession,
  SESSION_REFRESH_WINDOW_SECONDS,
  SESSION_TTL_SECONDS,
} from "@/lib/supabase/serverAuth";
import {
  createServerClientForToken,
  isServerSupabaseConfigured,
} from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function jsonError(
  message: string,
  status: number,
  code?: string,
  extra?: Record<string, unknown>
) {
  return NextResponse.json(
    { error: message, ...(code ? { code } : {}), ...(extra ?? {}) },
    { status, headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const authHeader = req.headers.get("authorization");
    let token = authHeader?.startsWith("Bearer ")
      ? authHeader.slice(7).trim()
      : null;
    let force = false;

    try {
      const body = await req.json();
      if (!token && typeof body?.token === "string") {
        token = body.token.trim();
      }
      if (body?.force === true) {
        force = true;
      }
    } catch {
      // Body is optional when token is passed via Authorization header
    }

    if (!token) {
      return jsonError(
        "Missing session token in Authorization header or body.",
        401,
        "UNAUTHORIZED"
      );
    }

    const result = refreshWalletSession(token, {
      refreshWindowSeconds: SESSION_REFRESH_WINDOW_SECONDS,
      ttlSeconds: SESSION_TTL_SECONDS,
      force,
    });

    if (!result.success) {
      return jsonError(
        result.error,
        result.status,
        result.code,
        result.remainingSeconds !== undefined
          ? { remainingSeconds: result.remainingSeconds }
          : undefined
      );
    }

    // Touch user profile last_login_at if database is configured
    if (isServerSupabaseConfigured()) {
      try {
        const client = createServerClientForToken(result.token);
        await client
          .from("users")
          .update({ last_login_at: new Date().toISOString() })
          .eq("wallet_address", result.claims.wallet_address);
      } catch (err) {
        console.warn("[auth/refresh] Could not update last_login_at:", err);
      }
    }

    return NextResponse.json(
      {
        token: result.token,
        expiresIn: result.expiresIn,
        claims: {
          sub: result.claims.sub,
          walletAddress: result.claims.wallet_address,
          exp: (result.claims as any).exp,
        },
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (err: any) {
    console.error("[auth/refresh] Unexpected refresh error:", err);
    return jsonError(err?.message || "Failed to refresh session.", 500);
  }
}
