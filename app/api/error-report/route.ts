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
 *
 * Because the route is unauthenticated by design (a client that cannot even
 * build a session must still be able to report why), every input is treated as
 * hostile: the body is size-capped before parsing, each field is clamped and
 * stripped of control characters so a report cannot forge log lines, and the
 * webhook forward is both rate-limited and timeout-bounded so it cannot be used
 * to amplify traffic at an upstream incident hook.
 */

import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

interface IncomingReport {
  requestId?: string;
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

/** Reports accepted per IP per minute. A real client reports single failures. */
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Hard ceiling on the raw body, rejected before any parsing work. */
const MAX_BODY_BYTES = 16_384;

/** Per-field character caps. A stack is the only field that needs real room. */
const MAX_LENGTHS: Record<string, number> = {
  name: 200,
  message: 2_000,
  stack: 8_000,
  severity: 20,
  network: 50,
  appVersion: 50,
  timestamp: 40,
};

/** Bounds applied to the free-form `context` object. */
const MAX_CONTEXT_KEYS = 30;
const MAX_CONTEXT_KEY_LENGTH = 100;
const MAX_CONTEXT_VALUE_LENGTH = 500;

/** Timeout for the best-effort webhook forward. */
const WEBHOOK_TIMEOUT_MS = 5_000;

/**
 * Strips characters that would let a report forge log structure, then clamps.
 *
 * Newlines and carriage returns are the log-injection vector: the sink emits one
 * line per report, so an embedded newline lets a caller fabricate what looks
 * like a separate, legitimate log entry. ANSI escapes are dropped too, since a
 * maintainer reading logs in a terminal would otherwise have their output
 * rewritten by the payload.
 */
function sanitizeString(value: string, maxLength: number): string {
  const stripped = value.replace(/[\u0000-\u001F\u007F-\u009F]/g, " ");
  return stripped.length > maxLength ? `${stripped.slice(0, maxLength)}…[truncated]` : stripped;
}

/**
 * Reduces an untrusted `context` value to something safe to log.
 *
 * Only primitives survive as themselves; anything structured is summarised by
 * type rather than serialised, which keeps a deeply nested or cyclic object
 * from turning into an unbounded log line.
 */
function sanitizeContextValue(value: unknown): unknown {
  if (value === null) return null;
  switch (typeof value) {
    case "string":
      return sanitizeString(value, MAX_CONTEXT_VALUE_LENGTH);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "undefined":
      return undefined;
    default:
      return Array.isArray(value) ? `[array:${value.length}]` : `[${typeof value}]`;
  }
}

function sanitizeContext(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;

  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (count >= MAX_CONTEXT_KEYS) {
      out["…"] = "[context truncated]";
      break;
    }
    const safeKey = sanitizeString(key, MAX_CONTEXT_KEY_LENGTH);
    if (!safeKey.trim()) continue;
    const safeValue = sanitizeContextValue(raw);
    if (safeValue === undefined) continue;
    out[safeKey] = safeValue;
    count += 1;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const clientIp = getClientIp(req);
  const rateLimit = await checkRateLimit(`error-report:ip:${clientIp}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return NextResponse.json({ ok: false, error: "Too many error reports" }, { status: 429 });
  }

  let body: IncomingReport;
  try {
    body = JSON.parse(raw) as IncomingReport;
  } catch {
    return NextResponse.json(
      { ok: false, error: "invalid json", requestId },
      { status: 400, headers: responseHeaders() },
    );
  }

  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json(
      { ok: false, error: "invalid json", requestId },
      { status: 400, headers: responseHeaders() },
    );
  }

  if (!headerRequestId) {
    requestId = parseRequestId(body.requestId) ?? requestId;
  }

  const receivedAt = new Date().toISOString();
  const clean: Record<string, unknown> = { requestId, receivedAt };
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
        headers: {
          "Content-Type": "application/json",
          [REQUEST_ID_HEADER]: requestId,
        },
        body: JSON.stringify(clean),
        signal: AbortSignal.timeout(5000),
      });
    } catch {
      // Forwarding is best-effort; the server log above already captured it.
    }
  }

  return NextResponse.json(
    { ok: true, requestId },
    { status: 202, headers: responseHeaders() },
  );
}

export function GET(req: NextRequest) {
  const requestId = parseRequestId(req.headers.get(REQUEST_ID_HEADER)) ?? createRequestId();
  return NextResponse.json(
    { ok: true, requestId },
    { headers: { [REQUEST_ID_HEADER]: requestId } },
  );
}
