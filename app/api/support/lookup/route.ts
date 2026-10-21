/**
 * app/api/support/lookup/route.ts
 *
 * Support Incident Lookup API (Issue #314).
 *
 * Provides a read-only, audited incident view for support staff investigating
 * payment failures, delays, or disputes.
 *
 * Acceptance criteria:
 * 1. Search by transaction hash, wallet, trip ID, expense ID, or correlation ID.
 * 2. Redacted timeline and network explorer links; zero secret exposure; read-only.
 * 3. Every staff lookup is audit logged.
 */

import { NextRequest, NextResponse } from "next/server";
import {
  checkStaffAuthorization,
  lookupIncident,
  recordSupportLookupAudit,
} from "@/lib/support/service";
import { type SupportQueryType } from "@/lib/support/types";
import { createServiceRoleClient, createServerAnonClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { getClientIp } from "@/lib/auth/rateLimiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function getClient() {
  if (!isServerSupabaseConfigured()) return undefined;
  try {
    return createServiceRoleClient() ?? createServerAnonClient();
  } catch {
    return undefined;
  }
}

async function handleLookup(request: NextRequest) {
  const auth = checkStaffAuthorization(request);
  if (!auth.authorized) {
    return NextResponse.json(
      {
        error: "Unauthorized: Access restricted to authorized support staff and operators.",
        code: "STAFF_AUTH_REQUIRED",
      },
      { status: 403 }
    );
  }

  let query = "";
  let queryType: SupportQueryType | undefined;

  if (request.method === "POST") {
    try {
      const body = await request.json();
      query = typeof body.query === "string" ? body.query.trim() : "";
      if (body.queryType) queryType = body.queryType;
    } catch {
      return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
    }
  } else {
    const { searchParams } = new URL(request.url);
    query = (searchParams.get("query") || searchParams.get("q") || "").trim();
    const typeParam = searchParams.get("type") || searchParams.get("queryType");
    if (typeParam) queryType = typeParam as SupportQueryType;
  }

  if (!query) {
    return NextResponse.json(
      {
        error: "Search query is required (txHash, wallet, tripId, expenseId, or correlationId).",
        code: "MISSING_QUERY",
      },
      { status: 400 }
    );
  }

  const client = getClient();
  const incident = await lookupIncident({ query, queryType }, client as any);

  // ── AUDIT LOGGING: Every staff lookup is logged ─────────────────────────────
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "unknown";

  await recordSupportLookupAudit(
    {
      staffIdentifier: auth.staffIdentifier,
      queryType: incident.detectedType,
      queryValueMasked: query,
      resultsCount: incident.found ? 1 : 0,
      ipAddress: ip,
      userAgent,
    },
    client as any
  );

  return NextResponse.json(
    {
      ok: true,
      data: incident,
    },
    {
      headers: {
        "Cache-Control": "no-store",
        "X-Read-Only-Mode": "true",
      },
    }
  );
}

export const GET = handleLookup;
export const POST = handleLookup;
