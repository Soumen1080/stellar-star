/**
 * /api/reminders/[id] (#326) — the payment-request deep link's data.
 *
 *   GET    the request's private context. Requires a wallet session, and only
 *          the request's sender or recipient gets anything but a 404.
 *   PATCH  { action }  dismiss | mute_trip | unmute_trip | mute_sender |
 *          unmute_sender (recipient), cancel (sender). Every choice is recorded.
 */

import type { NextRequest } from "next/server";
import { authenticate, json, readJson, UUID_PATTERN } from "@/lib/reminders/server";
import {
  applyReminderAction,
  loadRequestContext,
  REMINDER_ACTIONS,
  type ReminderAction,
} from "@/lib/reminders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Params) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return json({ error: "This payment request is not available." }, 404, auth.requestId);

  try {
    const result = await loadRequestContext(auth.deps, auth.wallet, id);
    if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
    return json({ data: result.context }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to load the request." }, 500, auth.requestId);
  }
}

export async function PATCH(request: NextRequest, { params }: Params) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const { id } = await params;
  if (!UUID_PATTERN.test(id)) return json({ error: "This payment request is not available." }, 404, auth.requestId);

  const body = await readJson(request);
  const action = body?.action;
  if (typeof action !== "string" || !REMINDER_ACTIONS.includes(action as ReminderAction)) {
    return json({ error: `action must be one of: ${REMINDER_ACTIONS.join(", ")}.` }, 400, auth.requestId);
  }

  try {
    const result = await applyReminderAction(auth.deps, auth.wallet, id, action as ReminderAction);
    if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
    return json({ data: { reminder: result.reminder, preferences: result.preferences ?? null } }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to update the request." }, 500, auth.requestId);
  }
}
