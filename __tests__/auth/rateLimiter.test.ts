/**
 * rateLimiter.test.ts
 *
 * Unit tests for sliding-window rate limiter in lib/auth/rateLimiter.ts.
 * Proves Issue #409:
 *  - Outage behavior: central limiter errors/exceptions fail closed with retryable 503.
 *  - Local development behavior: in-memory limiter permitted only in non-production.
 *  - Accurate "limiter unavailable" and throughput metrics.
 */

import {
  checkRateLimit,
  getClientIp,
  getRateLimiterMetrics,
  resetRateLimiterMetrics,
  rateLimiterUnavailableResponse,
  __resetRateLimitsForTests,
} from "@/lib/auth/rateLimiter";
import { NextRequest } from "next/server";
import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server");

describe("Rate Limiter (Issue #409 & Issue #158)", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    __resetRateLimitsForTests();
    jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("IP Extraction", () => {
    it("extracts IP correctly from headers with fallbacks", () => {
      const req1 = new NextRequest("http://localhost/api/auth/challenge", {
        headers: { "x-forwarded-for": "203.0.113.195, 70.41.3.18" },
      });
      expect(getClientIp(req1)).toBe("203.0.113.195");

      const req2 = new NextRequest("http://localhost/api/auth/challenge", {
        headers: { "x-real-ip": "198.51.100.1" },
      });
      expect(getClientIp(req2)).toBe("198.51.100.1");

      const req3 = new NextRequest("http://localhost/api/auth/challenge");
      expect(getClientIp(req3)).toBe("127.0.0.1");
    });
  });

  describe("Local Development Behavior (Non-Production In-Memory Limiter)", () => {
    beforeEach(() => {
      (process.env as any).NODE_ENV = "development";
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);
    });

    it("enforces limit within sliding window and allows requests again after window reset", async () => {
      const key = "test:user:1";
      const limit = 3;
      const windowMs = 10_000;
      const startTime = 1_000_000;

      // Requests 1, 2, 3 allowed
      const r1 = await checkRateLimit(key, limit, windowMs, startTime);
      expect(r1.allowed).toBe(true);
      expect(r1.remaining).toBe(2);
      expect(r1.unavailable).toBe(false);

      const r2 = await checkRateLimit(key, limit, windowMs, startTime + 1000);
      expect(r2.allowed).toBe(true);
      expect(r2.remaining).toBe(1);
      expect(r2.unavailable).toBe(false);

      const r3 = await checkRateLimit(key, limit, windowMs, startTime + 2000);
      expect(r3.allowed).toBe(true);
      expect(r3.remaining).toBe(0);
      expect(r3.unavailable).toBe(false);

      // Request 4 blocked within same window
      const r4 = await checkRateLimit(key, limit, windowMs, startTime + 3000);
      expect(r4.allowed).toBe(false);
      expect(r4.remaining).toBe(0);
      expect(r4.resetMs).toBe(7000);
      expect(r4.unavailable).toBe(false);

      // Request after window has elapsed is allowed again
      const r5 = await checkRateLimit(key, limit, windowMs, startTime + 10_500);
      expect(r5.allowed).toBe(true);
      expect(r5.remaining).toBe(2);
      expect(r5.unavailable).toBe(false);

      const metrics = getRateLimiterMetrics();
      expect(metrics.totalChecks).toBe(5);
      expect(metrics.allowedCount).toBe(4);
      expect(metrics.blockedCount).toBe(1);
      expect(metrics.inMemoryChecks).toBe(5);
      expect(metrics.durableChecks).toBe(0);
      expect(metrics.unavailableCount).toBe(0);
    });
  });

  describe("Production Requirement & Enforcement", () => {
    it("fails closed when unconfigured in production environment (NODE_ENV=production)", async () => {
      (process.env as any).NODE_ENV = "production";
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(result.remaining).toBe(0);
      expect(result.error).toContain("Durable rate limiter is required in production");

      const metrics = getRateLimiterMetrics();
      expect(metrics.totalChecks).toBe(1);
      expect(metrics.unavailableCount).toBe(1);
      expect(metrics.inMemoryChecks).toBe(0);
      expect(metrics.lastUnavailableAt).not.toBeNull();
      expect(metrics.lastError).toContain("Durable rate limiter is required in production");
    });

    it("fails closed when VALIDATE_PRODUCTION=1 even if NODE_ENV is test", async () => {
      (process.env as any).NODE_ENV = "test";
      process.env.VALIDATE_PRODUCTION = "1";
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);

      const metrics = getRateLimiterMetrics();
      expect(metrics.unavailableCount).toBe(1);
    });
  });

  describe("Outage Behavior (Central Limiter Unavailable)", () => {
    beforeEach(() => {
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(true);
    });

    it("fails closed when central limiter RPC returns an error (outage/failure)", async () => {
      const mockRpc = jest.fn().mockResolvedValue({
        data: null,
        error: { message: "database connection timeout", code: "PGRST000" },
      });
      jest.mocked(createServiceRoleClient).mockReturnValue({
        rpc: mockRpc,
      } as any);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(result.remaining).toBe(0);
      expect(result.error).toBe("database connection timeout");

      // Verify no silent in-memory fallback occurred
      const metrics = getRateLimiterMetrics();
      expect(metrics.totalChecks).toBe(1);
      expect(metrics.unavailableCount).toBe(1);
      expect(metrics.inMemoryChecks).toBe(0);
      expect(metrics.durableChecks).toBe(0);
      expect(metrics.lastError).toBe("database connection timeout");
    });

    it("fails closed when central limiter RPC throws an unexpected exception", async () => {
      const mockRpc = jest.fn().mockRejectedValue(new Error("network failure: ECONNREFUSED"));
      jest.mocked(createServiceRoleClient).mockReturnValue({
        rpc: mockRpc,
      } as any);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);
      expect(result.remaining).toBe(0);
      expect(result.error).toContain("ECONNREFUSED");

      const metrics = getRateLimiterMetrics();
      expect(metrics.unavailableCount).toBe(1);
      expect(metrics.lastError).toContain("ECONNREFUSED");
    });

    it("fails closed when createServiceRoleClient returns null", async () => {
      jest.mocked(createServiceRoleClient).mockReturnValue(null);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);

      const metrics = getRateLimiterMetrics();
      expect(metrics.unavailableCount).toBe(1);
      expect(metrics.lastError).toContain("Service role client could not be created");
    });

    it("fails closed when central RPC returns empty response", async () => {
      const mockRpc = jest.fn().mockResolvedValue({ data: null, error: null });
      jest.mocked(createServiceRoleClient).mockReturnValue({
        rpc: mockRpc,
      } as any);

      const result = await checkRateLimit("api:rate:key", 10, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.unavailable).toBe(true);

      const metrics = getRateLimiterMetrics();
      expect(metrics.unavailableCount).toBe(1);
    });
  });

  describe("Durable Limiter Success (Happy Path)", () => {
    beforeEach(() => {
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(true);
    });

    it("returns allowed result when central RPC allows request", async () => {
      const mockRpc = jest.fn().mockResolvedValue({
        data: { allowed: true, remaining: 4, reset_ms: 15_000 },
        error: null,
      });
      jest.mocked(createServiceRoleClient).mockReturnValue({
        rpc: mockRpc,
      } as any);

      const result = await checkRateLimit("api:rate:key", 5, 60_000);

      expect(result.allowed).toBe(true);
      expect(result.remaining).toBe(4);
      expect(result.resetMs).toBe(15_000);
      expect(result.count).toBe(1);
      expect(result.unavailable).toBe(false);

      const metrics = getRateLimiterMetrics();
      expect(metrics.totalChecks).toBe(1);
      expect(metrics.durableChecks).toBe(1);
      expect(metrics.allowedCount).toBe(1);
      expect(metrics.blockedCount).toBe(0);
      expect(metrics.unavailableCount).toBe(0);
    });

    it("returns blocked result when central RPC reports limit exceeded", async () => {
      const mockRpc = jest.fn().mockResolvedValue({
        data: { allowed: false, remaining: 0, reset_ms: 8_000 },
        error: null,
      });
      jest.mocked(createServiceRoleClient).mockReturnValue({
        rpc: mockRpc,
      } as any);

      const result = await checkRateLimit("api:rate:key", 5, 60_000);

      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.resetMs).toBe(8_000);
      expect(result.unavailable).toBe(false);

      const metrics = getRateLimiterMetrics();
      expect(metrics.totalChecks).toBe(1);
      expect(metrics.durableChecks).toBe(1);
      expect(metrics.allowedCount).toBe(0);
      expect(metrics.blockedCount).toBe(1);
      expect(metrics.unavailableCount).toBe(0);
    });
  });

  describe("Rate Limiter Metrics Management", () => {
    it("accurately reports and resets metrics counters", async () => {
      // 1 in-memory check
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);
      (process.env as any).NODE_ENV = "test";
      await checkRateLimit("key1", 5, 10_000);

      // 1 outage check
      jest.mocked(isServerSupabaseConfigured).mockReturnValue(true);
      jest.mocked(createServiceRoleClient).mockReturnValue(null);
      await checkRateLimit("key2", 5, 10_000);

      const metricsBefore = getRateLimiterMetrics();
      expect(metricsBefore.totalChecks).toBe(2);
      expect(metricsBefore.inMemoryChecks).toBe(1);
      expect(metricsBefore.unavailableCount).toBe(1);

      // Reset metrics
      resetRateLimiterMetrics();
      const metricsAfter = getRateLimiterMetrics();
      expect(metricsAfter.totalChecks).toBe(0);
      expect(metricsAfter.allowedCount).toBe(0);
      expect(metricsAfter.blockedCount).toBe(0);
      expect(metricsAfter.unavailableCount).toBe(0);
      expect(metricsAfter.inMemoryChecks).toBe(0);
      expect(metricsAfter.durableChecks).toBe(0);
      expect(metricsAfter.lastUnavailableAt).toBeNull();
      expect(metricsAfter.lastError).toBeNull();
    });
  });

  describe("Retryable 503 Service Unavailable Response Helper", () => {
    it("produces standardized retryable 503 response with Retry-After header", async () => {
      const rateResult = {
        allowed: false,
        remaining: 0,
        resetMs: 15_000,
        unavailable: true,
      };

      const response = rateLimiterUnavailableResponse(rateResult, "req-12345");

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("15");
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(response.headers.get("x-request-id")).toBe("req-12345");

      const body = await response.json();
      expect(body.code).toBe("RATE_LIMITER_UNAVAILABLE");
      expect(body.retryAfterSeconds).toBe(15);
      expect(body.requestId).toBe("req-12345");
      expect(body.error).toContain("Rate limiting service is temporarily unavailable");
    });

    it("defaults Retry-After to at least 1 second even if resetMs is 0", () => {
      const response = rateLimiterUnavailableResponse({
        allowed: false,
        remaining: 0,
        resetMs: 0,
        unavailable: true,
      });

      expect(response.headers.get("Retry-After")).toBe("1");
    });
  });
});
