/**
 * /api/reminders (#326)
 *
 *   GET  ?role=recipient|sender   the caller's reminders (inbox / sent)
 *   POST { tripId, expenseId, memberId, note? }   send one reminder
 *
 * Sending is always an explicit action by the payer of the expense; see
 * lib/reminders/policy.ts for who may ask, and the rate limits.
 */

import type { NextRequest } from "next/server";
import { normalizeNote } from "@/lib/reminders/policy";
import { authenticate, ID_PATTERN, json, readJson } from "@/lib/reminders/server";
import { sendReminder } from "@/lib/reminders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const role = request.nextUrl.searchParams.get("role") === "sender" ? "sender" : "recipient";
  try {
    const reminders = await auth.deps.repo.listReminders(auth.wallet, role, 50);
    // Muted reminders are kept for history but not shown in the inbox.
    const visible = role === "recipient" ? reminders.filter((r) => r.state !== "muted") : reminders;
    return json({ data: visible }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to load reminders." }, 500, auth.requestId);
  }
}

export async function POST(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400, auth.requestId);
  const { tripId, expenseId, memberId } = body;
  if (![tripId, expenseId, memberId].every((v) => typeof v === "string" && ID_PATTERN.test(v))) {
    return json({ error: "tripId, expenseId and memberId are required." }, 400, auth.requestId);
  }
  const note = normalizeNote(body.note);
  if (note === "invalid") return json({ error: "The note must be 280 characters or fewer." }, 400, auth.requestId);

  try {
    const result = await sendReminder(auth.deps, {
      senderWallet: auth.wallet,
      tripId: tripId as string,
      expenseId: expenseId as string,
      memberId: memberId as string,
      note,
      trigger: "manual",
    });
    if (!result.ok) {
      const headers: Record<string, string> = result.retryAfterMs
        ? { "Retry-After": String(Math.ceil(result.retryAfterMs / 1000)) }
        : {};
      return json({ error: result.message }, result.status, auth.requestId, headers);
    }
    return json({ data: { reminder: result.reminder, channels: result.channels } }, 201, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to send the reminder." }, 500, auth.requestId);
  }
}
