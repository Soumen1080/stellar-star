import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { sendTestWebhookPing } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["webhooks:manage"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body.", status: 400 } },
      { status: 400 }
    );
  }

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
    const delivery = await sendTestWebhookPing(webhookId, tokenPayload.walletAddress);

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
      idempotencyKey: null,
    });

    return NextResponse.json({ data: delivery });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to execute webhook test.";
    return NextResponse.json(
      { error: { code: "TEST_FAILED", message, status: 400 } },
      { status: 400 }
    );
  }
}
