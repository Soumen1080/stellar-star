import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { deleteWebhookEndpoint } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["webhooks:manage"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const { id } = await params;

  const deleted = deleteWebhookEndpoint(id, tokenPayload.walletAddress);

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "DELETE",
    path: `/api/v1/webhooks/${id}`,
    statusCode: deleted ? 200 : 404,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  if (!deleted) {
    return NextResponse.json(
      {
        error: {
          code: "NOT_FOUND",
          message: "Webhook endpoint not found or not owned by caller.",
          status: 404,
        },
      },
      { status: 404 }
    );
  }

  return NextResponse.json({ success: true, message: "Webhook successfully deleted." });
}
