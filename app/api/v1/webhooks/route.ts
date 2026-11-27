import { NextRequest, NextResponse } from "next/server";
import { authenticateApiRequest, recordAuditLog } from "@/lib/api/middleware";
import { parseJsonBody } from "@/lib/api/bodyLimits";
import { toPublicErrorResponse } from "@/lib/api/errors";
import { createDurableWebhookEndpoint, listDurableWebhookEndpoints } from "@/lib/api/webhooks";

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
  const webhooks = await listDurableWebhookEndpoints(tokenPayload.walletAddress);

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
    requireIdempotencyKey: true,
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const idempotencyKey = auth.context.idempotencyKey as string;

  const parsedBody = await parseJsonBody(request, { route: "/api/v1/webhooks", format: "v1" });
  if (!parsedBody.ok) return parsedBody.response;
  const body = parsedBody.value as {
    url?: unknown;
    events?: unknown;
    description?: unknown;
  };
  const { url, events, description } = body;

  try {
    const endpoint = await createDurableWebhookEndpoint({
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

    return NextResponse.json({ data: endpoint }, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err: unknown) {
    return toPublicErrorResponse(err, {
      format: "v1",
      fallbackMessage: "Failed to register webhook.",
      route: "/api/v1/webhooks",
      method: "POST",
      status: 400,
      code: "WEBHOOK_REGISTRATION_FAILED",
    });
  }
}
