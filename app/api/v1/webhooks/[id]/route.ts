import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { deleteWebhookEndpoint } from "@/lib/api/webhooks";
import { runIdempotentMutation } from "@/lib/idempotency/route";

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

  return runIdempotentMutation({
    request,
    key: idempotencyKey,
    replayFields: ["success", "message"],
    principal: tokenPayload.walletAddress,
    payload: { webhookId: id },
    // The endpoint registry is process-local; so is the replay.
    persist: false,
    format: "v1",
    execute: async () => {
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
        idempotencyKey,
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
    },
  });
}
