import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, getAuditLogsForWallet } from "@/lib/api/middleware";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await authenticateApiRequest(request);

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload } = auth.context;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "50", 10), 1), 100);

  const logs = getAuditLogsForWallet(tokenPayload.walletAddress, limit);

  return NextResponse.json({ data: logs });
}
