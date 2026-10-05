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
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

interface IncomingReport {
  name?: string;
  message?: string;
  stack?: string;
  severity?: string;
  context?: Record<string, unknown>;
  network?: string;
  appVersion?: string;
  timestamp?: string;
  requestId?: string;
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
  "requestId",
];

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const rateLimit = await checkRateLimit(`error-report:ip:${clientIp}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many error reports" }, { status: 429 });
  }

  let body: IncomingReport;
  try {
    body = (await req.json()) as IncomingReport;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  const receivedAt = new Date().toISOString();
  const clean: Record<string, unknown> = { receivedAt };
  for (const key of ALLOWED_KEYS) {
    if (body[key] !== undefined) {
      const val = body[key];
      if (typeof val === "string") {
        clean[key] = val.slice(0, key === "stack" ? 4000 : 2000);
      } else {
        clean[key] = val;
      }
    }
  }

  if (!clean.requestId) {
    const headerReqId = req.headers.get("x-request-id");
    if (headerReqId) clean.requestId = headerReqId.slice(0, 100);
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
        signal: AbortSignal.timeout(5000),
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
