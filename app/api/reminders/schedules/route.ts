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
import { requireIdempotencyKey, runIdempotentMutation } from "@/lib/idempotency/route";
import { REMINDER_SCHEDULE_REPLAY_FIELDS, replayFieldsUnder } from "@/lib/idempotency/replay";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { toPublicErrorResponse } from "@/lib/api/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  try {
    return json({ data: await auth.deps.repo.listSchedules(auth.wallet) }, 200, auth.requestId);
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.requestId,
      fallbackMessage: "Failed to load schedules.",
      route: "/api/reminders/schedules",
      method: "GET",
    });
  }
}

export async function POST(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;
  const body = await readJson(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400, auth.requestId);
  try {
    return await runIdempotentMutation({
      request,
      client: auth.client,
      key: idempotency.key,
      replayFields: replayFieldsUnder("data", REMINDER_SCHEDULE_REPLAY_FIELDS),
      principal: auth.wallet,
      payload: { tripId: body.tripId ?? null, intervalDays: body.intervalDays ?? null },
      replayHeaders: { [REQUEST_ID_HEADER]: auth.requestId },
      execute: async () => {
        const result = await createSchedule(auth.deps, auth.wallet, body.tripId, body.intervalDays);
        if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
        return json({ data: result.schedule }, 201, auth.requestId);
      },
    });
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.requestId,
      fallbackMessage: "Failed to create the schedule.",
      route: "/api/reminders/schedules",
      method: "POST",
    });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  // Issue #412: a valid key is required before any work.
  const idempotency = requireIdempotencyKey(request);
  if (!idempotency.ok) return idempotency.response;
  const id = request.nextUrl.searchParams.get("id") ?? "";
  if (!UUID_PATTERN.test(id)) return json({ error: "A schedule id is required." }, 400, auth.requestId);
  try {
    return await runIdempotentMutation({
      request,
      client: auth.client,
      key: idempotency.key,
      replayFields: ["data.disabled"],
      principal: auth.wallet,
      payload: { scheduleId: id },
      replayHeaders: { [REQUEST_ID_HEADER]: auth.requestId },
      execute: async () => {
        const result = await disableSchedule(auth.deps, auth.wallet, id);
        if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
        return json({ data: { disabled: true } }, 200, auth.requestId);
      },
    });
  } catch (err) {
    return toPublicErrorResponse(err, {
      requestId: auth.requestId,
      fallbackMessage: "Failed to disable the schedule.",
      route: "/api/reminders/schedules",
      method: "DELETE",
    });
  }
}
