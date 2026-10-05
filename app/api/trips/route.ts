import { NextRequest, NextResponse } from "next/server";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import { createServerClientForToken, isServerSupabaseConfigured } from "@/lib/supabase/server";
import {
  fetchTripsPaginated,
  insertTrip,
  parsePaginationParams,
  MAX_PAGE_SIZE,
  DEFAULT_PAGE_SIZE,
} from "@/lib/supabase/queries";
import type { Trip } from "@/types/trip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to view trips." },
      { status: 401 }
    );
  }

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
    const client = createServerClientForToken(token);
    const result = await fetchTripsPaginated(parsed, client);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to load trips.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return NextResponse.json(
      { error: "Unauthorized: Sign in with your wallet to create a trip." },
      { status: 401 }
    );
  }

  let body: any;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

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
    const client = createServerClientForToken(token);
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

    const saved = await insertTrip(tripToSave, session.wallet_address, client);
    return NextResponse.json(saved, { status: 201 });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to create trip.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
