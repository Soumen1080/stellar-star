/**
 * lib/api/errors.ts
 *
 * Stable public error mapping and internal error hiding (Issue #420).
 * Server only.
 *
 * Returning raw `error.message` exposes database schemas, table and column names,
 * connection strings, provider endpoints, JWT tokens, Stellar secret keys, and
 * internal implementation choices to clients and potential attackers. It also causes
 * clients to couple to accidental wording.
 *
 * This module guarantees:
 *   1. All server/internal failures map to stable, documented public codes and safe
 *      non-disclosing messages.
 *   2. Every error response includes a `requestId` in the body and `X-Request-Id`
 *      header for support tracing.
 *   3. Detailed, unredacted internal causes are logged ONLY to server-side telemetry
 *      correlated by that `requestId` (via `reportError`), with secrets/tokens redacted.
 *   4. Both the standard `flat` ({ error, code, requestId }) and developer `v1`
 *      ({ error: { code, message, status, requestId } }) envelopes are supported.
 */

import { NextResponse } from "next/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { reportError } from "@/lib/observability/reportError";

// Stable public error codes (Issue #420)
export const INTERNAL_ERROR_CODE = "INTERNAL_ERROR";
export const DATABASE_ERROR_CODE = "DATABASE_ERROR";
export const DATABASE_TIMEOUT_CODE = "DATABASE_TIMEOUT";
export const DATABASE_UNAVAILABLE_CODE = "DATABASE_UNAVAILABLE";
export const ACCESS_DENIED_CODE = "ACCESS_DENIED";
export const RESOURCE_CONFLICT_CODE = "RESOURCE_CONFLICT";
export const RECORD_NOT_FOUND_CODE = "RECORD_NOT_FOUND";
export const PROVIDER_UNAVAILABLE_CODE = "PROVIDER_UNAVAILABLE";
export const PROVIDER_TIMEOUT_CODE = "PROVIDER_TIMEOUT";
export const INVALID_REQUEST_CODE = "INVALID_REQUEST";
export const RATE_LIMITED_CODE = "RATE_LIMITED";

export type ApiErrorFormat = "flat" | "v1";

export interface PublicErrorDetails {
  status: number;
  code: string;
  message: string;
  headers?: Record<string, string>;
  isInternal: boolean;
}

export interface PublicErrorOptions {
  requestId?: string | null;
  fallbackMessage?: string;
  route?: string;
  method?: string;
  format?: ApiErrorFormat;
  status?: number;
  code?: string;
  context?: Record<string, unknown>;
  headers?: Record<string, string>;
}

/**
 * An explicitly safe, public-facing domain error.
 * Handlers can throw or return this when they intentionally want to communicate
 * a safe error to the client.
 */
export class PublicApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly isPublic = true;
  readonly headers?: Record<string, string>;

  constructor(
    message: string,
    code = INTERNAL_ERROR_CODE,
    status = 500,
    headers?: Record<string, string>
  ) {
    super(message);
    this.name = "PublicApiError";
    this.code = code;
    this.status = status;
    this.headers = headers;
  }
}

/**
 * Checks whether an error message or string contains sensitive internal secrets,
 * stack traces, database schema specifics, or connection strings.
 */
export function containsSensitiveData(text: string): boolean {
  return (
    // Stellar secrets (starts with S, 56 chars)
    /S[A-Z0-9]{55}/.test(text) ||
    // JWT tokens
    /ey[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/.test(text) ||
    // Stellar XDR payloads
    /AAAA[A-Za-z0-9+/=]{60,}/.test(text) ||
    // SQL / Postgres schema and internal syntax
    /relation\s+["']?[a-zA-Z0-9_.]+["']?\s+does\s+not\s+exist/i.test(text) ||
    /column\s+["']?[a-zA-Z0-9_.]+["']?\s+(?:of\s+relation\s+.*)?does\s+not\s+exist/i.test(text) ||
    /syntax\s+error\s+at\s+or\s+near/i.test(text) ||
    /table\s+["']?[a-zA-Z0-9_.]+["']?/i.test(text) ||
    /database\s+["']?[a-zA-Z0-9_.]+["']?/i.test(text) ||
    /violates\s+(?:not-null|foreign\s+key|check)\s+constraint/i.test(text) ||
    /password|secret|bearer\s+|private_key|api_key/i.test(text) ||
    // Hostnames, internal IPs, connection strings
    /postgres(?:ql)?:\/\//i.test(text) ||
    /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}(?::\d+)?\b/.test(text) ||
    /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(text) ||
    // Node stack trace lines
    /^\s*at\s+.*\(?.*:\d+:\d+\)?/m.test(text)
  );
}

/**
 * Classifies an unknown error into a safe public status, stable code, and safe message.
 * Internal database/provider errors are never exposed raw.
 */
export function classifyApiError(err: unknown, fallbackMessage?: string): PublicErrorDetails {
  const defaultInternalMessage = fallbackMessage || "An unexpected internal error occurred.";

  if (!err) {
    return {
      status: 500,
      code: INTERNAL_ERROR_CODE,
      message: defaultInternalMessage,
      isInternal: true,
    };
  }

  // 1. Explicitly public errors (PublicApiError, RequestBodyError, IdempotencyKeyError, etc.)
  if (err instanceof PublicApiError) {
    const safeMsg = containsSensitiveData(err.message) ? defaultInternalMessage : err.message;
    return {
      status: err.status,
      code: err.code,
      message: safeMsg,
      headers: err.headers,
      isInternal: err.status >= 500,
    };
  }

  const errObj = typeof err === "object" && err !== null ? (err as Record<string, unknown>) : null;
  const rawMessage = err instanceof Error ? err.message : String(err);
  const rawCode = typeof errObj?.code === "string" ? errObj.code : undefined;
  const rawStatus = typeof errObj?.status === "number" ? errObj.status : undefined;

  // 2. Client-safe domain errors with status < 500 (e.g. 400 validation, 404 not found, 409 conflict, 413, 415)
  if (rawStatus && rawStatus >= 400 && rawStatus < 500 && rawCode) {
    const isSensitive = containsSensitiveData(rawMessage);
    return {
      status: rawStatus,
      code: rawCode,
      message: isSensitive ? "Invalid request." : rawMessage,
      isInternal: false,
    };
  }

  // 3. Stellar resilience errors
  if (rawCode === "STELLAR_CIRCUIT_OPEN") {
    const retryAfter = typeof errObj?.retryAfterSeconds === "number" ? String(errObj.retryAfterSeconds) : "15";
    return {
      status: 503,
      code: "STELLAR_CIRCUIT_OPEN",
      message: "Upstream Stellar service is temporarily unavailable. Please retry shortly.",
      headers: { "Retry-After": retryAfter },
      isInternal: true,
    };
  }
  if (rawCode === "STELLAR_TIMEOUT") {
    return {
      status: 504,
      code: PROVIDER_TIMEOUT_CODE,
      message: "Upstream Stellar provider timed out. Please try again.",
      isInternal: true,
    };
  }
  if (rawCode === "STELLAR_BULKHEAD_REJECTED") {
    return {
      status: 503,
      code: "STELLAR_BULKHEAD_REJECTED",
      message: "Service concurrency limit reached. Please try again shortly.",
      isInternal: true,
    };
  }

  // 4. Database Deadlines / Budgets / Timeouts (57014, 55P03, 25P03)
  if (
    rawCode === "57014" ||
    rawCode === "55P03" ||
    rawCode === "25P03" ||
    /statement timeout|query_canceled|lock timeout|canceling statement due to statement timeout/i.test(rawMessage) ||
    /database_deadline_exceeded|database_query_timeout|query_count_budget_exceeded|query_duration_budget_exceeded/i.test(rawMessage)
  ) {
    return {
      status: 504,
      code: DATABASE_TIMEOUT_CODE,
      message: "Database operation timed out. Please retry with a narrower query.",
      isInternal: true,
    };
  }

  // 5. Database Setup / Missing Table / Schema Cache (PGRST205)
  if (
    rawCode === "PGRST205" ||
    /schema cache/i.test(rawMessage) ||
    /relation .* does not exist/i.test(rawMessage) ||
    /connection refused|failed to connect to database/i.test(rawMessage)
  ) {
    return {
      status: 503,
      code: DATABASE_UNAVAILABLE_CODE,
      message: "Database service is temporarily unavailable.",
      isInternal: true,
    };
  }

  // 6. Database Permission / RLS Policy (42501, PGRST301)
  if (
    rawCode === "42501" ||
    rawCode === "PGRST301" ||
    /permission denied|row-level security/i.test(rawMessage)
  ) {
    return {
      status: 403,
      code: ACCESS_DENIED_CODE,
      message: "You do not have permission to perform this action.",
      isInternal: true,
    };
  }

  // 7. Database Unique / Duplicate Violation (23505)
  if (
    rawCode === "23505" ||
    /duplicate key value|unique constraint/i.test(rawMessage)
  ) {
    return {
      status: 409,
      code: RESOURCE_CONFLICT_CODE,
      message: "A conflict occurred with an existing record.",
      isInternal: false,
    };
  }

  // 8. General Database Error (DatabaseError or Postgres error code)
  if (
    errObj?.name === "DatabaseError" ||
    (rawCode && /^[0-9A-Z]{5}$/.test(rawCode)) ||
    (rawCode && rawCode.startsWith("PGRST"))
  ) {
    return {
      status: 500,
      code: DATABASE_ERROR_CODE,
      message: fallbackMessage || "A database error occurred while processing your request.",
      isInternal: true,
    };
  }

  // 9. Upstream Provider / Horizon / Soroban network faults
  if (
    /horizon|soroban|rpc provider|stellar rpc/i.test(rawMessage) ||
    /bad gateway|gateway timeout|service unavailable/i.test(rawMessage)
  ) {
    return {
      status: 503,
      code: PROVIDER_UNAVAILABLE_CODE,
      message: "An upstream service is temporarily unavailable. Please retry shortly.",
      isInternal: true,
    };
  }

  // 10. Default fallback for all other unexpected errors
  return {
    status: 500,
    code: INTERNAL_ERROR_CODE,
    message: defaultInternalMessage,
    isInternal: true,
  };
}

/**
 * Builds a sanitized, stable JSON error response and logs the unredacted cause
 * to server telemetry correlated with the request ID.
 */
export function toPublicErrorResponse(
  err: unknown,
  options: PublicErrorOptions = {}
): NextResponse {
  const requestId = getOrCreateRequestId(options.requestId);
  const classified = classifyApiError(err, options.fallbackMessage);

  const status = options.status ?? classified.status;
  const code = options.code ?? classified.code;
  const message = classified.message;

  // Log detailed, redacted error telemetry correlated by requestId (Issue #420)
  try {
    reportError(
      options.route ? `api.error:${options.route}` : "api.error",
      err,
      {
        route: options.route,
        method: options.method,
        code,
        status,
        ...options.context,
      },
      status >= 500 ? "error" : "warning",
      requestId
    );
  } catch {
    // Telemetry must never crash the error response path
  }

  const responseHeaders: Record<string, string> = {
    "Cache-Control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
    ...classified.headers,
    ...options.headers,
  };

  if (options.format === "v1") {
    return NextResponse.json(
      {
        error: {
          code,
          message,
          status,
          requestId,
        },
      },
      {
        status,
        headers: responseHeaders,
      }
    );
  }

  return NextResponse.json(
    {
      error: message,
      code,
      requestId,
    },
    {
      status,
      headers: responseHeaders,
    }
  );
}
