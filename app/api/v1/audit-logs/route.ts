import { NextRequest } from "next/server";
import { authenticateApiRequest, getAuditLogsForWallet } from "@/lib/api/middleware";
import { limitedJson, responseLimitFor } from "@/lib/api/bodyLimits";

/** Every JSON response here is size-capped (#418). */
const respond = (body: unknown, init?: ResponseInit) =>
  limitedJson(body, init, responseLimitFor("/api/v1/audit-logs"));

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

  return respond({ data: logs });
}
