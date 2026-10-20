import { timingSafeEqual } from "crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildDeps } from "@/lib/reminders/server";
import { runDueSchedules } from "@/lib/reminders/service";

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
 * Runs member-created reminder schedules that are due (issue #326), e.g. a
 * daily cron with `Authorization: Bearer $CRON_SECRET`.
 *
 * It only ever acts on `reminder_schedules` rows a member created; with none,
 * it sends nothing. Per-share rate limits still apply, and each schedule is
 * advanced before it is processed so overlapping runs do not double-send.
 */
async function run(request: NextRequest) {
  if (!authorized(request)) {
    return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  }
  const service = createServiceRoleClient();
  if (!service) {
    return NextResponse.json(
      { error: "SUPABASE_SERVICE_ROLE_KEY is required for scheduled reminders." },
      { status: 503 },
    );
  }
  try {
    const result = await runDueSchedules(buildDeps(request, { user: null, service }));
    return NextResponse.json({ data: result }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Scheduled reminders failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export const GET = run;
export const POST = run;
