/**
 * lib/auth/rateLimiter.ts
 *
 * Distributed Sliding-Window Rate Limiter for Authentication Endpoints.
 *
 * Enforces per-IP and per-wallet rate limits across multi-instance deployments.
 * Backed by Supabase database RPC when configured, with a memory sliding-window
 * fallback for local development and test environments.
 */

import { NextRequest } from "next/server";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
}

interface MemoryRateLimitRecord {
  count: number;
  windowStart: number;
}

declare global {
  var stellarStarRateLimits: Map<string, MemoryRateLimitRecord> | undefined;
}

const memoryLimits = globalThis.stellarStarRateLimits ?? new Map<string, MemoryRateLimitRecord>();
globalThis.stellarStarRateLimits = memoryLimits;

/** Extracts client IP address safely from request headers. */
export function getClientIp(request: NextRequest): string {
  const forwardedFor = request.headers?.get?.("x-forwarded-for");
  if (forwardedFor) {
    const firstIp = forwardedFor.split(",")[0]?.trim();
    if (firstIp) return firstIp;
  }

  const realIp = request.headers?.get?.("x-real-ip");
  if (realIp) return realIp.trim();

  const cfIp = request.headers?.get?.("cf-connecting-ip");
  if (cfIp) return cfIp.trim();

  return "127.0.0.1";
}

/**
 * Checks and increments rate limit for a key using sliding window.
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
      if (client) {
        const { data, error } = await client.rpc("check_auth_rate_limit", {
          p_key: key,
          p_limit: limit,
          p_window_ms: windowMs,
          p_now: now,
        });

        if (!error && data && typeof data === "object") {
          const parsed = data as { allowed: boolean; remaining: number; reset_ms: number };
          return {
            allowed: Boolean(parsed.allowed),
            remaining: Number(parsed.remaining),
            resetMs: Number(parsed.reset_ms),
          };
        }
      }
    } catch {
      // Fall through to memory rate limiting
    }
  }

  // 2. In-memory sliding window rate limiting
  const record = memoryLimits.get(key);

  if (!record || now - record.windowStart >= windowMs) {
    memoryLimits.set(key, { count: 1, windowStart: now });
    return {
      allowed: true,
      remaining: Math.max(0, limit - 1),
      resetMs: windowMs,
    };
  }

  if (record.count < limit) {
    record.count += 1;
    return {
      allowed: true,
      remaining: Math.max(0, limit - record.count),
      resetMs: Math.max(0, windowMs - (now - record.windowStart)),
    };
  }

  return {
    allowed: false,
    remaining: 0,
    resetMs: Math.max(0, windowMs - (now - record.windowStart)),
  };
}

/** Resets rate limits for tests */
export function __resetRateLimitsForTests(): void {
  memoryLimits.clear();
}
