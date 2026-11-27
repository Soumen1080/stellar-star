import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { toPublicErrorResponse } from "@/lib/api/errors";
import { deleteDurableWebhookEndpoint } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["webhooks:manage"],
    requireIdempotencyKey: true,
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const idempotencyKey = auth.context.idempotencyKey as string;
  const { id } = await params;

  try {
    const deleted = await deleteDurableWebhookEndpoint(id, tokenPayload.walletAddress);
    const statusCode = deleted ? 200 : 404;

    recordAuditLog({
      timestamp: new Date().toISOString(),
      tokenId: tokenPayload.tokenId,
      walletAddress: tokenPayload.walletAddress,
      method: "DELETE",
      path: `/api/v1/webhooks/${id}`,
      statusCode,
      latencyMs: Date.now() - startTime,
      ip,
      userAgent,
      idempotencyKey,
    });

    if (!deleted) {
      return NextResponse.json(
        {
          error: {
            code: "NOT_FOUND",
            message: "Webhook endpoint not found or not owned by caller.",
            status: statusCode,
          },
        },
        { status: statusCode },
      );
    }

    return NextResponse.json({ success: true, message: "Webhook successfully deleted." });
  } catch (err: unknown) {
    return toPublicErrorResponse(err, {
      format: "v1",
      fallbackMessage: "Failed to delete webhook.",
      route: "/api/v1/webhooks/[id]",
      method: "DELETE",
      status: 400,
      code: "WEBHOOK_DELETION_FAILED",
    });
  }
}
