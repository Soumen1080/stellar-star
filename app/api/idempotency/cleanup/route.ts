import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { purgeIdempotencyRecords } from "@/lib/idempotency/cleanup";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(request: NextRequest): boolean {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const actual = Buffer.from(request.headers.get("authorization") ?? "");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * Idempotency retention sweep (issue #414), scheduled daily by Vercel Cron
 * with `Authorization: Bearer $CRON_SECRET`. Disabled (401) when CRON_SECRET
 * is unset. Batched and safe to re-run: a repeat only finds less to do.
 */
async function sweep(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  try {
    const data = await purgeIdempotencyRecords(createServiceRoleClient());
    return NextResponse.json({ data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json(
      { error: "The idempotency retention sweep failed. It will run again on schedule." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}

export const GET = sweep;
export const POST = sweep;
