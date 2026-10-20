import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { fetchTripById } from "@/lib/api/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["settlement:read"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const url = new URL(request.url);
  const tripId = url.searchParams.get("trip_id");

  if (tripId) {
    const trip = await fetchTripById(tripId, tokenPayload.walletAddress);
    if (!trip) {
      return NextResponse.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Trip not found or caller lacks permission.",
            status: 404,
          },
        },
        { status: 404 }
      );
    }
  }

  // Aggregate mock settlement status for developer integrations
  const data = [
    {
      id: crypto.randomUUID(),
      trip_id: tripId || "sample-trip-id",
      status: "completed",
      ledger: 489201,
      settled_at: new Date().toISOString(),
      on_chain: true,
      currency: "XLM",
    },
  ];

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "GET",
    path: "/api/v1/settlements",
    statusCode: 200,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  return NextResponse.json({ data });
}
