import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { fetchTripById } from "@/lib/api/data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["trips:read"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const { id } = await params;

  const trip = await fetchTripById(id, tokenPayload.walletAddress);

  if (!trip) {
    recordAuditLog({
      timestamp: new Date().toISOString(),
      tokenId: tokenPayload.tokenId,
      walletAddress: tokenPayload.walletAddress,
      method: "GET",
      path: `/api/v1/trips/${id}`,
      statusCode: 404,
      latencyMs: Date.now() - startTime,
      ip,
      userAgent,
      idempotencyKey: null,
    });

    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Trip not found or caller lacks permission to access it.",
          status: 404,
        },
      },
      { status: 404 }
    );
  }

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "GET",
    path: `/api/v1/trips/${id}`,
    statusCode: 200,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  return NextResponse.json({ data: trip });
}
