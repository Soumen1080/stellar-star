import { NextRequest, NextResponse } from "next/server";
import {
  apiIdempotencyClient,
  authenticateApiRequest,
  recordAuditLog,
} from "@/lib/api/middleware";
import { runIdempotentMutation } from "@/lib/idempotency/route";
import { TRIP_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";
import { fetchPermittedTrips, insertTrip } from "@/lib/api/data";
import { dispatchWebhookEvent } from "@/lib/api/webhooks";
import type { Trip } from "@/types/trip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["trips:read"],
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") || "20", 10), 1), 100);
  const cursor = url.searchParams.get("cursor");

  const { trips, hasMore, nextCursor } = await fetchPermittedTrips(
    tokenPayload.walletAddress,
    limit,
    cursor
  );

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "GET",
    path: "/api/v1/trips",
    statusCode: 200,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey: null,
  });

  return NextResponse.json({
    data: trips,
    pagination: {
      limit,
      cursor: nextCursor,
      has_more: hasMore,
    },
  });
}

export async function POST(request: NextRequest) {
  const startTime = Date.now();
  const auth = await authenticateApiRequest(request, {
    requiredScopes: ["trips:write"],
    requireIdempotencyKey: true,
  });

  if (!auth.success) {
    return auth.response;
  }

  const { tokenPayload, ip, userAgent } = auth.context;
  const idempotencyKey = auth.context.idempotencyKey as string;

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "BAD_REQUEST", message: "Invalid JSON body.", status: 400 } },
      { status: 400 }
    );
  }

  if (!body.name || typeof body.name !== "string" || !body.name.trim()) {
    return NextResponse.json(
      { error: { code: "VALIDATION_FAILED", message: "Trip name is required.", status: 400 } },
      { status: 400 }
    );
  }

  if (!Array.isArray(body.members) || body.members.length === 0) {
    return NextResponse.json(
      {
        error: {
          code: "VALIDATION_FAILED",
          message: "Trip must include at least one member.",
          status: 400,
        },
      },
      { status: 400 }
    );
  }

  const response = await runIdempotentMutation({
    request,
    client: apiIdempotencyClient(),
    key: idempotencyKey,
    replayFields: replayFieldsUnder("data", TRIP_REPLAY_FIELDS),
    principal: tokenPayload.walletAddress,
    payload: body,
    format: "v1",
    execute: async () => {
      const tripId = crypto.randomUUID();
      const newTrip: Trip = {
        id: tripId,
        name: body.name.trim(),
        description: body.description?.trim() || "",
        members: body.members.map((m: any) => ({
          id: crypto.randomUUID(),
          name: String(m.name || "").trim(),
          walletAddress: m.wallet_address ? String(m.wallet_address).trim().toUpperCase() : undefined,
        })),
        expenseIds: [],
        startsOn: body.starts_on || undefined,
        endsOn: body.ends_on || undefined,
        createdAt: new Date().toISOString(),
        settled: false,
        createdByWallet: tokenPayload.walletAddress,
      };

      const created = await insertTrip(newTrip);

      // Dispatch webhook event
      dispatchWebhookEvent({
        event: "trip.created",
        data: {
          trip_id: created.id,
          name: created.name,
          member_count: created.members.length,
          created_by_wallet: created.createdByWallet,
          created_at: created.createdAt,
        },
        walletAddress: tokenPayload.walletAddress,
      }).catch(() => {});

      return NextResponse.json({ data: created }, { status: 201 });
    },
  });

  recordAuditLog({
    timestamp: new Date().toISOString(),
    tokenId: tokenPayload.tokenId,
    walletAddress: tokenPayload.walletAddress,
    method: "POST",
    path: "/api/v1/trips",
    statusCode: response.status,
    latencyMs: Date.now() - startTime,
    ip,
    userAgent,
    idempotencyKey,
  });

  return response;
}
