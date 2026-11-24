import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

export async function enforceTokenManagementLimit(request: NextRequest, walletAddress: string) {
  const max = 20;
  const result = await checkRateLimit(`api:token-management:${walletAddress.toUpperCase()}:${getClientIp(request)}`, max, 60_000);
  if (result.allowed) return null;
  const retryAfter = Math.ceil(result.resetMs / 1000);
  return NextResponse.json(
    { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many token-management requests.", status: 429 } },
    { status: 429, headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(max), "X-RateLimit-Remaining": "0" } },
  );
}
