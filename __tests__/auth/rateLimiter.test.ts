/**
 * rateLimiter.test.ts
 *
 * Unit tests for sliding-window rate limiter in lib/auth/rateLimiter.ts.
 */

import {
  checkRateLimit,
  getClientIp,
  __resetRateLimitsForTests,
} from "@/lib/auth/rateLimiter";
import { NextRequest } from "next/server";
import { isServerSupabaseConfigured } from "@/lib/supabase/server";

jest.mock("@/lib/supabase/server");

describe("Rate Limiter (Issue #158 / Epic #52)", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetRateLimitsForTests();
    jest.mocked(isServerSupabaseConfigured).mockReturnValue(false);
  });

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

  it("enforces limit within sliding window and allows requests again after window reset", async () => {
    const key = "test:user:1";
    const limit = 3;
    const windowMs = 10_000;
    const startTime = 1_000_000;

    // Requests 1, 2, 3 allowed
    const r1 = await checkRateLimit(key, limit, windowMs, startTime);
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = await checkRateLimit(key, limit, windowMs, startTime + 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = await checkRateLimit(key, limit, windowMs, startTime + 2000);
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);

    // Request 4 blocked within same window
    const r4 = await checkRateLimit(key, limit, windowMs, startTime + 3000);
    expect(r4.allowed).toBe(false);
    expect(r4.remaining).toBe(0);
    expect(r4.resetMs).toBe(7000);

    // Request after window has elapsed is allowed again
    const r5 = await checkRateLimit(key, limit, windowMs, startTime + 10_500);
    expect(r5.allowed).toBe(true);
    expect(r5.remaining).toBe(2);
  });
});
