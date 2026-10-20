/**
 * Error reporting for the money path.
 *
 * The brief: a failed money-path operation must produce a *diagnosable record
 * somewhere a maintainer will actually see it*. `console.error` is not that
 * place — it is buried in a user's browser console and is the first thing to be
 * lost. This module is the single seam every failure routes through.
 *
 * Default behaviour (no vendor configured): POST a structured report to the
 * internal `/api/error-report` route, which logs it server-side in a stable,
 * grep-friendly shape. That keeps the record on infrastructure the maintainer
 * controls (server logs / their log pipeline), not the user's DevTools. If that
 * POST fails, it degrades to `console.error` rather than swallowing the error.
 *
 * The vendor is deliberately pluggable: `setErrorReporter` lets a deployment
 * swap in Sentry, Datadog, a webhook, or anything else without touching call
 * sites. Call sites only ever call `reportError`.
 */

import { STELLAR_NETWORK, APP_VERSION } from "@/lib/utils/constants";
import {
  REQUEST_ID_HEADER,
  getOrCreateRequestId,
} from "@/lib/observability/requestId";

export type ErrorSeverity = "info" | "warning" | "error";

export interface ReportedError {
  requestId: string;
  name: string;
  message: string;
  stack?: string;
  severity: ErrorSeverity;
  context?: Record<string, unknown>;
  network: string;
  appVersion: string;
  timestamp: string;
  /** True when the report reached the internal sink (best-effort only). */
  reported?: boolean;
}

export type ErrorReporter = (report: ReportedError) => void | Promise<void>;

const INTERNAL_ENDPOINT = "/api/error-report";
const STRUCTURED_PREFIX = "[StellarStar:error]";

let customReporter: ErrorReporter | null = null;

/** Swap in a vendor reporter (Sentry, webhook, test spy, …). Pass null to reset. */
export function setErrorReporter(reporter: ErrorReporter | null): void {
  customReporter = reporter;
}

/**
 * Strips secret keys, JWTs, XDR payloads, and private tokens from error reports.
 */
export function redactSensitiveData(context?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!context || typeof context !== "object") return context;

  const out: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(context)) {
    // Redact sensitive keys
    if (/xdr|secret|private|token|jwt|auth|password|seed|credential/i.test(key)) {
      out[key] = "[REDACTED]";
      continue;
    }

    if (typeof val === "string") {
      const trimmed = val.trim();
      // Stellar secret key (starts with S, 56 chars)
      if (/^S[A-Z0-9]{55}$/.test(trimmed)) {
        out[key] = "[REDACTED_STELLAR_SECRET]";
      }
      // JWT token
      else if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(trimmed)) {
        out[key] = "[REDACTED_JWT]";
      }
      // Stellar XDR payload (starts with AAAA or long base64 string)
      else if (/^AAAA[A-Za-z0-9+/=]{40,}$/.test(trimmed) || (trimmed.length > 80 && /^[A-Za-z0-9+/=]+={0,2}$/.test(trimmed))) {
        out[key] = "[REDACTED_XDR_PAYLOAD]";
      } else {
        // Redact any embedded secret keys in strings
        out[key] = val
          .replace(/S[A-Z0-9]{55}/g, "[REDACTED_STELLAR_SECRET]")
          .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
          .replace(/AAAA[A-Za-z0-9+/=]{60,}/g, "[REDACTED_XDR_PAYLOAD]");
      }
    } else if (Array.isArray(val)) {
      out[key] = val.map((item) =>
        typeof item === "object" && item !== null
          ? redactSensitiveData(item as Record<string, unknown>)
          : typeof item === "string"
          ? (/^S[A-Z0-9]{55}$/.test(item.trim())
              ? "[REDACTED_STELLAR_SECRET]"
              : /^AAAA[A-Za-z0-9+/=]{40,}$/.test(item.trim())
              ? "[REDACTED_XDR_PAYLOAD]"
              : item)
          : item,
      );
    } else if (typeof val === "object" && val !== null) {
      out[key] = redactSensitiveData(val as Record<string, unknown>);
    } else {
      out[key] = val;
    }
  }

  return out;
}

function sanitizeText(text: string): string {
  return text
    .replace(/S[A-Z0-9]{55}/g, "[REDACTED_STELLAR_SECRET]")
    .replace(/ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[REDACTED_JWT]")
    .replace(/AAAA[A-Za-z0-9+/=]{60,}/g, "[REDACTED_XDR_PAYLOAD]");
}

function toMessage(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return {
      message: sanitizeText(error.message),
      stack: error.stack ? sanitizeText(error.stack) : undefined,
    };
  }
  if (typeof error === "string") return { message: sanitizeText(error) };
  try {
    return { message: sanitizeText(JSON.stringify(error)) };
  } catch {
    return { message: sanitizeText(String(error)) };
  }
}

export function buildReport(
  name: string,
  error: unknown,
  context?: Record<string, unknown>,
  severity: ErrorSeverity = "error",
  requestId?: string,
): ReportedError {
  const { message, stack } = toMessage(error);
  const explicitRequestId =
    requestId ||
    (typeof context?.requestId === "string" ? context.requestId : undefined);
  const resolvedRequestId = getOrCreateRequestId(explicitRequestId);

  return {
    requestId: resolvedRequestId,
    name,
    message,
    stack,
    severity,
    context: redactSensitiveData(context),
    network: STELLAR_NETWORK,
    appVersion: APP_VERSION,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Reports an error. Fire-and-forget: never throws, never blocks the caller.
 *
 * Priority: custom reporter (if set) → internal API route (browser) →
 * `console.error` fallback. The internal route is what makes the failure
 * diagnosable on infrastructure the maintainer owns rather than the user's
 * console.
 */
export function reportError(
  name: string,
  error: unknown,
  context?: Record<string, unknown>,
  severity: ErrorSeverity = "error",
  requestId?: string,
): void {
  const report = buildReport(name, error, context, severity, requestId);

  if (customReporter) {
    try {
      void customReporter(report);
    } catch {
      // Reporter broke — fall through to the default sink below.
    }
    return;
  }

  if (typeof window !== "undefined") {
    // Fire-and-forget, but wrapped so that a missing/throws `fetch` (e.g. an
    // environment without it) degrades to console.error instead of blowing up
    // the caller — a money-path failure must never be turned into a crash.
    void (async () => {
      try {
        await fetch(INTERNAL_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            [REQUEST_ID_HEADER]: report.requestId,
          },
          body: JSON.stringify(report),
          keepalive: true,
        });
      } catch {
        console.error(
          STRUCTURED_PREFIX,
          report.requestId,
          report.name,
          report.message,
          report.context ?? ""
        );
      }
    })();
    return;
  }

  // Server context: log directly (e.g. contract code imported by an API route).
  console.error(STRUCTURED_PREFIX, JSON.stringify(report));
}

/**
 * Convenience for the payment flow: tags the report with the stage of the
 * money path it failed at, plus the network and app version.
 */
export function reportMoneyPathError(
  stage: string,
  error: unknown,
  context?: Record<string, unknown>,
  requestId?: string,
): void {
  reportError(`money-path.${stage}`, error, context, "error", requestId);
}
