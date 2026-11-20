/**
 * lib/auth/rateLimiter.ts
 *
 * Distributed Sliding-Window Rate Limiter for Authentication & Protected Endpoints.
 *
 * Enforces per-IP and per-wallet rate limits across multi-instance deployments.
 * Backed by Supabase database RPC when configured.
 *
 * In accordance with Issue #409:
 * - Fail closed when central durable limiter is unavailable (e.g. database error,
 *   outage, or unconfigured in production) by returning { allowed: false, unavailable: true }
 *   and rejecting protected requests with a retryable 503.
 * - In-memory sliding-window limiter is permitted ONLY in explicitly non-production
 *   environments (e.g. local development and unit tests).
 * - Exposes accurate "limiter unavailable" and throughput metrics.
 */

import { NextRequest, NextResponse } from "next/server";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  count?: number;
  unavailable?: boolean;
  error?: string;
}

export interface RateLimiterMetrics {
  totalChecks: number;
  allowedCount: number;
  blockedCount: number;
  unavailableCount: number;
  durableChecks: number;
  inMemoryChecks: number;
  lastUnavailableAt: number | null;
  lastError: string | null;
}

interface MemoryRateLimitRecord {
  count: number;
  windowStart: number;
}

declare global {
  var stellarStarRateLimits: Map<string, MemoryRateLimitRecord> | undefined;
  var stellarStarRateLimiterMetrics: RateLimiterMetrics | undefined;
}

const memoryLimits = globalThis.stellarStarRateLimits ?? new Map<string, MemoryRateLimitRecord>();
globalThis.stellarStarRateLimits = memoryLimits;

// Re-export ingress-aware client IP resolver (Issue #410)
export {
  getClientIp,
  resolveClientIp,
  normalizeIp,
  isApprovedIngress,
  type IpResolverOptions,
} from "@/lib/security/ipResolver";

/**
 * Checks and increments rate limit for a key using sliding window.
 *
 * In production or when Supabase is configured:
 *  - Calls central durable Supabase RPC `check_auth_rate_limit`.
 *  - If central limiter is down / errors / throws, FAILS CLOSED with `unavailable: true`.
 *  - In-memory counters are NEVER used in production.
 *
 * In explicitly non-production environments (test/development) without Supabase:
 *  - Uses memory-backed sliding-window rate limiting.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowMs: number,
  now = Date.now(),
): Promise<RateLimitResult> {
  // 1. Try distributed database rate limiting if Supabase is configured
  if (isServerSupabaseConfigured()) {
    try {
      const client = createServiceRoleClient();
      if (!client) {
        return handleRateLimiterUnavailable(
          "Service role client could not be created",
          windowMs,
        );
      }

      const { data, error } = await client.rpc("check_auth_rate_limit", {
        p_key: key,
        p_limit: limit,
        p_window_ms: windowMs,
        p_now: now,
      });

      if (error) {
        const errorMsg =
          typeof error === "object" && error !== null && "message" in error
            ? String((error as { message: unknown }).message)
            : "Rate limit RPC failed";
        return handleRateLimiterUnavailable(errorMsg, windowMs);
      }

      if (data && typeof data === "object") {
        const parsed = data as {
          allowed: boolean;
          remaining: number;
          reset_ms?: number;
          resetMs?: number;
          count?: number;
        };
        const resetMs = Number(parsed.reset_ms ?? parsed.resetMs ?? windowMs);
        const remaining = Number(parsed.remaining ?? 0);
        const allowed = Boolean(parsed.allowed);
        const count =
          typeof parsed.count === "number"
            ? parsed.count
            : Math.max(0, limit - remaining);

        metrics.totalChecks += 1;
        metrics.durableChecks += 1;
        if (allowed) {
          metrics.allowedCount += 1;
        } else {
          metrics.blockedCount += 1;
        }

        return {
          allowed,
          remaining,
          resetMs,
          count,
          unavailable: false,
        };
      }

      return handleRateLimiterUnavailable(
        "Empty response from rate limit RPC",
        windowMs,
      );
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return handleRateLimiterUnavailable(errorMsg, windowMs);
    }
  }

  // 2. If Supabase is NOT configured:
  const isProduction =
    process.env.NODE_ENV === "production" ||
    process.env.VALIDATE_PRODUCTION === "1";

  if (isProduction) {
    // In production, durable central rate limiting is mandatory.
    // In-memory limiting across separate serverless/container instances allows limit multiplication.
    return handleRateLimiterUnavailable(
      "Durable rate limiter is required in production but central limiter is not configured",
      windowMs,
    );
  }

  // 3. In-memory sliding window rate limiting (non-production only)
  metrics.totalChecks += 1;
  metrics.inMemoryChecks += 1;
  const record = memoryLimits.get(key);

  if (!record || now - record.windowStart >= windowMs) {
    memoryLimits.set(key, { count: 1, windowStart: now });
    metrics.allowedCount += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetMs: windowMs,
      unavailable: false,
    };
  }

  if (record.count < limit) {
    record.count += 1;
    metrics.allowedCount += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - record.count),
      resetMs: Math.max(0, windowMs - (now - record.windowStart)),
      unavailable: false,
    };
  }

  metrics.blockedCount += 1;
  return {
    allowed: false,
    remaining: 0,
    resetMs: Math.max(0, windowMs - (now - record.windowStart)),
    unavailable: false,
  };
}

/**
 * Standard HTTP 503 Service Unavailable response for when rate limiting is unavailable.
 * Sets Retry-After header and returns safe, standardized JSON telemetry.
 */
export function rateLimiterUnavailableResponse(
  result?: RateLimitResult,
  requestId?: string,
  customMessage?: string,
): NextResponse {
  const retrySeconds = Math.max(1, Math.ceil((result?.resetMs ?? 10_000) / 1000));
  const body: Record<string, unknown> = {
    error:
      customMessage ||
      "Rate limiting service is temporarily unavailable. Please retry shortly.",
    code: "RATE_LIMITER_UNAVAILABLE",
    retryAfterSeconds: retrySeconds,
  };
  if (requestId) {
    body.requestId = requestId;
  }

  return NextResponse.json(body, {
    status: 503,
    headers: {
      "Retry-After": String(retrySeconds),
      "Cache-Control": "no-store",
      ...(requestId ? { "x-request-id": requestId } : {}),
    },
  });
}

/** Resets rate limits and metrics for tests */
export function __resetRateLimitsForTests(): void {
  memoryLimits.clear();
  resetRateLimiterMetrics();
}
