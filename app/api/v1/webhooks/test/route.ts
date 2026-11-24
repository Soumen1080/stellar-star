import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { enqueueDurableWebhookPing } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
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

  let body: any;
  const parsedBody = await parseJsonBody(request, { route: "/api/v1/webhooks/test", format: "v1" });
  if (!parsedBody.ok) return parsedBody.response;
  body = parsedBody.value;

  const webhookId = body.webhook_id;
  if (!webhookId || typeof webhookId !== "string") {
    return NextResponse.json(
      {
        error: {
          code: "MISSING_PARAMETER",
          message: "Field 'webhook_id' is required.",
          status: 400,
        },
      },
      { status: 400 }
    );
  }

  try {
    const delivery = await enqueueDurableWebhookPing(webhookId, tokenPayload.walletAddress);

        recordAuditLog({
          timestamp: new Date().toISOString(),
          tokenId: tokenPayload.tokenId,
          walletAddress: tokenPayload.walletAddress,
          method: "POST",
          path: "/api/v1/webhooks/test",
          statusCode: 200,
          latencyMs: Date.now() - startTime,
          ip,
          userAgent,
          idempotencyKey,
        });

        return NextResponse.json({ data: delivery });
      } catch (err: unknown) {
        return toPublicErrorResponse(err, {
          format: "v1",
          fallbackMessage: "Failed to execute webhook test.",
          route: "/api/v1/webhooks/test",
          method: "POST",
          status: 400,
          code: "TEST_FAILED",
        });
      }
    },
  });
}
