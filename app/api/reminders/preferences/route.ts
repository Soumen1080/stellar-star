/**
 * /api/reminders/preferences (#326) — the caller's own delivery choices.
 *
 *   GET  current preferences (defaults: in-app only, nothing muted)
 *   PUT  { emailOptIn?, emailAddress?, pushOptIn?, pushEndpoint? }
 *
 * Email and push are off until the member turns them on here.
 */

import type { NextRequest } from "next/server";
import { defaultPreferences } from "@/lib/reminders/repository";
import { authenticate, json, readJson } from "@/lib/reminders/server";
import { updatePreferences } from "@/lib/reminders/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const preferences =
    (await auth.deps.repo.getPreferences(auth.wallet, "own")) ?? defaultPreferences(auth.wallet);
  return json({ data: preferences }, 200, auth.requestId);
}

export async function PUT(request: NextRequest) {
  const auth = authenticate(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return json({ error: "Request body must be a JSON object." }, 400, auth.requestId);

  try {
    const result = await updatePreferences(auth.deps, auth.wallet, body);
    if (!result.ok) return json({ error: result.message }, result.status, auth.requestId);
    return json({ data: result.preferences }, 200, auth.requestId);
  } catch (err) {
    return json({ error: err instanceof Error ? err.message : "Failed to save preferences." }, 500, auth.requestId);
  }
}
