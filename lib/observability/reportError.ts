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

export type ErrorSeverity = "info" | "warning" | "error";

export interface ReportedError {
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

function toMessage(error: unknown): { message: string; stack?: string } {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  if (typeof error === "string") return { message: error };
  try {
    return { message: JSON.stringify(error) };
  } catch {
    return { message: String(error) };
  }
}

export function buildReport(
  name: string,
  error: unknown,
  context?: Record<string, unknown>,
  severity: ErrorSeverity = "error"
): ReportedError {
  const { message, stack } = toMessage(error);
  return {
    name,
    message,
    stack,
    severity,
    context,
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
  severity: ErrorSeverity = "error"
): void {
  const report = buildReport(name, error, context, severity);

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
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(report),
          keepalive: true,
        });
      } catch {
        console.error(
          STRUCTURED_PREFIX,
          report.name,
          report.message,
          report.context ?? ""
        );
      }
    })();
    return;
  }

  // Server context: log directly (e.g. contract code imported by an API route).
  console.error(STRUCTURED_PREFIX, report.name, report.message, report.context ?? "");
}

/**
 * Convenience for the payment flow: tags the report with the stage of the
 * money path it failed at, plus the network and app version.
 */
export function reportMoneyPathError(
  stage: string,
  error: unknown,
  context?: Record<string, unknown>
): void {
  reportError(`money-path.${stage}`, error, context);
}
