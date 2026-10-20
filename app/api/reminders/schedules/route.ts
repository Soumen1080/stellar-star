/**
 * /api/reminders/schedules (#326) — opt-in reminder schedules.
 *
 *   GET                          the caller's active schedules
 *   POST   { tripId, intervalDays }  create (replaces an existing one for the trip)
 *   DELETE ?id=                  turn a schedule off
 *
 * A schedule is the only way a reminder is sent without a click, and only a
 * member can create one, for their own receivables.
 */

import type { NextRequest } from "next/server";
import { authenticate, json, readJson, UUID_PATTERN } from "@/lib/reminders/server";
import { createSchedule, disableSchedule } from "@/lib/reminders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  try {
    return json({ data: await auth.deps.repo.listSchedules(auth.wallet) }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to load schedules." }, 500, auth.requestId);
  }
}

export async function POST(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400, auth.requestId);
  try {
    const result = await createSchedule(auth.deps, auth.wallet, body.tripId, body.intervalDays);
    if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
    return json({ data: result.schedule }, 201, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to create the schedule." }, 500, auth.requestId);
  }
}

export async function DELETE(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(id)) return json({ error: "A schedule id is required." }, 400, auth.requestId);
  try {
    const result = await disableSchedule(auth.deps, auth.wallet, id);
    if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
    return json({ data: { disabled: true } }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to disable the schedule." }, 500, auth.requestId);
  }
}
