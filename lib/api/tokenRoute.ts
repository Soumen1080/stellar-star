import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";
import { createServiceRoleClient } from "@/lib/supabase/server";

export async function enforceTokenManagementLimit(request: NextRequest, walletAddress: string) {
  const client = createServiceRoleClient();
  if (client) {
    const { data, error } = await (client as any).from("deleted_accounts").select("wallet_address").eq("wallet_address", walletAddress.trim().toUpperCase()).maybeSingle();
    if (error) return NextResponse.json({ error: { code: "ACCOUNT_STATUS_UNAVAILABLE", message: "Unable to verify account status.", status: 503 } }, { status: 503 });
    if (data) return NextResponse.json({ error: { code: "ACCOUNT_DELETED", message: "This account has been deleted.", status: 401 } }, { status: 401 });
  }
  const max = 20;
  const result = await checkRateLimit(`api:token-management:${walletAddress.toUpperCase()}:${getClientIp(request)}`, max, 60_000);
  if (result.allowed) return null;
  const retryAfter = Math.ceil(result.resetMs / 1000);
  return NextResponse.json(
    { error: { code: "RATE_LIMIT_EXCEEDED", message: "Too many token-management requests.", status: 429 } },
    { status: 429, headers: { "Retry-After": String(retryAfter), "X-RateLimit-Limit": String(max), "X-RateLimit-Remaining": "0" } },
  );
}
