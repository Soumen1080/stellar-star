import { NextRequest, NextResponse } from "next/server";
import { isServerSupabaseConfigured } from "@/lib/supabase/server";
import {
  fetchTripsPaginated,
  insertTrip,
  parsePaginationParams,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/supabase/queries";
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { TRIP_REPLAY_FIELDS } from "@/lib/idempotency/replay";
import type { Trip } from "@/types/trip";
import { authenticateWalletRequest } from "@/lib/api/routeGuard";
import { toPublicErrorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: Sign in with your wallet to view trips." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

  const { searchParams } = request.nextUrl;
  const rawLimit = searchParams.get("limit");
  const rawCursor = searchParams.get("cursor");
  const rawOffset = searchParams.get("offset");

  let parsed;
  try {
    parsed = parsePaginationParams({
      limit: rawLimit,
      cursor: rawCursor,
      offset: rawOffset,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Invalid pagination parameters.";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = auth.ctx.db();
    const result = await fetchTripsPaginated(parsed, client);
    return NextResponse.json(result);
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.ctx.requestId,
      fallbackMessage: "Failed to load trips.",
      route: "/api/trips",
      method: "GET",
    });
  }
}

export async function POST(request: NextRequest) {
  const auth = authenticateWalletRequest(request, { message: "Unauthorized: Sign in with your wallet to create a trip." });
  if (!auth.ok) return auth.response;
  const session = auth.ctx.claims;

  let body: any;
  const parsedBody = await parseJsonBody(request, { route: "/api/trips" });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request, { body });
  if (!idempotency.ok) return idempotency.response;

  const { name, description, members } = body ?? {};
  if (!name || typeof name !== "string" || !name.trim()) {
    return NextResponse.json({ error: "Trip name is required." }, { status: 400 });
  }

  if (!Array.isArray(members) || members.length < 2) {
    return NextResponse.json(
      { error: "Trip must include at least two members." },
      { status: 400 }
    );
  }

  if (!isServerSupabaseConfigured()) {
    return NextResponse.json(
      { error: "Database service is not configured on the server." },
      { status: 503 }
    );
  }

  try {
    const client = auth.ctx.db();

    const tripToSave: Trip = {
      id: body.id || crypto.randomUUID(),
      name: name.trim(),
      description: description?.trim() || undefined,
      members,
      expenseIds: [],
      settled: false,
      createdAt: new Date().toISOString(),
      createdByWallet: session.wallet_address,
    };

    return await runIdempotentMutation({
      request,
      client,
      key: idempotency.key,
      replayFields: TRIP_REPLAY_FIELDS,
      principal: session.wallet_address,
      // Kept from the pre-#412 wrapper so keys stored before the change still match.
      endpoint: "/api/trips",
      payload: body,
      execute: async () => {
        const saved = await insertTrip(tripToSave, session.wallet_address, client);
        return NextResponse.json(saved, { status: 201, headers: { "Cache-Control": "no-store" } });
      },
    });
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.ctx.requestId,
      fallbackMessage: "Failed to create trip.",
      route: "/api/trips",
      method: "POST",
    });
  }
}
