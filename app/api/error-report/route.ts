/**
 * Internal error-report sink.
 *
 * Client money-path failures POST here via `reportError` (lib/observability/
 * reportError). By landing in server logs in a stable, structured shape, the
 * failure becomes diagnosable on infrastructure the maintainer owns — not the
 * user's browser console, which is where `console.error` failures go to die.
 *
 * If `ERROR_REPORTING_WEBHOOK` is set, the same payload is also forwarded to
 * that URL (e.g. a Slack/Discord/incident hook) so a mainnet money-path
 * failure produces an alert, not just a log line.
 */

import { NextRequest, NextResponse } from "next/server";

interface IncomingReport {
  name?: string;
  message?: string;
  stack?: string;
  severity?: string;
  context?: Record<string, unknown>;
  network?: string;
  appVersion?: string;
  timestamp?: string;
}

const ALLOWED_KEYS: (keyof IncomingReport)[] = [
  "name",
  "message",
  "stack",
  "severity",
  "context",
  "network",
  "appVersion",
  "timestamp",
];

export async function POST(req: NextRequest) {
  let body: IncomingReport;
  try {
    body = (await req.json()) as IncomingReport;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const receivedAt = new Date().toISOString();
  const clean: Record<string, unknown> = { receivedAt };
  for (const key of ALLOWED_KEYS) {
    if (body[key] !== undefined) clean[key] = body[key];
  }

  // Stable, machine-parseable marker so log pipelines can route/alert on it.
  console.error(`[StellarStar:client-error] ${JSON.stringify(clean)}`);

  const webhook = process.env.ERROR_REPORTING_WEBHOOK;
  if (webhook) {
    try {
      await fetch(webhook, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(clean),
      });
    } catch {
      // Forwarding is best-effort; the server log above already captured it.
    }
  }

  return NextResponse.json({ ok: true }, { status: 202 });
}

export function GET() {
  return NextResponse.json({ ok: true });
}
