import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { registerWebhookEndpoint, listWebhooksForWallet } from "@/lib/api/webhooks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["webhooks:manage"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const webhooks = listWebhooksForWallet(tokenPayload.walletAddress);

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "GET",
    path: "/api/v1/webhooks",
    statusCode: 200,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  return NextResponse.json({ data: webhooks });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["webhooks:manage"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent, idempotencyKey } = auth.context;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body.", status: 400 } },
      { status: 400 }
    );
  }

  const { url, events, description } = body;

  try {
    const endpoint = registerWebhookEndpoint({
      walletAddress: tokenPayload.walletAddress,
      url: String(url || ""),
      events: Array.isArray(events) ? events : ["trip.created", "expense.created", "settlement.completed"],
      description: description ? String(description) : undefined,
    });

    recordAuditLog({
      timestamp: new Date().toISOString(),
      tokenId: tokenPayload.tokenId,
      walletAddress: tokenPayload.walletAddress,
      method: "POST",
      path: "/api/v1/webhooks",
      statusCode: 201,
      latencyMs: Date.now() - startTime,
      ip,
      userAgent,
      idempotencyKey,
    });

    return NextResponse.json({ data: endpoint }, { status: 201 });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to register webhook.";
    return NextResponse.json(
      { error: { code: "WEBHOOK_REGISTRATION_FAILED", message, status: 400 } },
      { status: 400 }
    );
  }
}
