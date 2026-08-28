/**
 * RateCache — unit tests.
 *
 * Covers:
 *   - Fresh hit: returns without an upstream call.
 *   - Stale hit: returns with `stale: true` and a non-zero `rateAgeMs`.
 *   - Fully expired entry: evicted, treated as a miss.
 *   - Miss: falls through (returns null from get()).
 *   - Stampede protection: N concurrent coalesce() calls for the same pair
 *     produce exactly one invocation of the upstream function.
 *   - In-flight map is cleaned up after the promise settles (success and error).
 */

import { RateCache } from "@/lib/fx/rateCache";
import type { FreshnessPolicy } from "@/lib/fx/types";

const POLICY: FreshnessPolicy = { ttlMs: 1_000, maxStaleMs: 5_000 };

describe("RateCache — get()", () => {
  it("returns null on a miss", () => {
    const cache = new RateCache();
    expect(cache.get("INR", "XLM")).toBeNull();
  });

  it("returns a fresh result within TTL", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("INR", "XLM", 0.00014, "coingecko", POLICY, now);

    const result = cache.get("INR", "XLM", now + 500); // 500 ms < 1000 ms TTL
    expect(result).not.toBeNull();
    expect(result!.rate).toBeCloseTo(0.00014);
    expect(result!.stale).toBe(false);
    expect(result!.source).toBe("coingecko");
    expect(result!.rateAgeMs).toBe(500);
    expect(result!.unavailable).toBe(false);
  });

  it("returns a stale result between TTL and maxStale", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("INR", "XLM", 0.00014, "coingecko", POLICY, now);

    // 2000 ms > TTL (1000) but < maxStale (5000)
    const result = cache.get("INR", "XLM", now + 2_000);
    expect(result).not.toBeNull();
    expect(result!.stale).toBe(true);
    expect(result!.rateAgeMs).toBe(2_000);
  });

  it("evicts entries older than maxStale", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("INR", "XLM", 0.00014, "coingecko", POLICY, now);

    // 6000 ms > maxStale (5000)
    const result = cache.get("INR", "XLM", now + 6_000);
    expect(result).toBeNull();
    expect(cache.size).toBe(0); // Entry should be evicted.
  });

  it("is case-insensitive on the currency code", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("inr", "xlm", 0.00014, "coingecko", POLICY, now);
    const result = cache.get("INR", "XLM", now + 100);
    expect(result).not.toBeNull();
    expect(result!.rate).toBeCloseTo(0.00014);
  });
});

describe("RateCache — set()", () => {
  it("overwrites an existing entry", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("INR", "XLM", 0.00014, "coingecko", POLICY, now);
    cache.set("INR", "XLM", 0.00020, "exchangerate-host", POLICY, now + 100);
    const result = cache.get("INR", "XLM", now + 100);
    expect(result!.rate).toBeCloseTo(0.00020);
    expect(result!.source).toBe("exchangerate-host");
  });
});

describe("RateCache — coalesce() (stampede protection)", () => {
  it("calls the upstream function exactly once for N concurrent requests", async () => {
    const cache = new RateCache();
    let callCount = 0;

    const upstream = async () => {
      callCount += 1;
      // Simulate async work.
      await new Promise((r) => setTimeout(r, 20));
      return {
        rate: 0.00014,
        source: "coingecko",
        fetchedAt: Date.now(),
        stale: false,
        rateAgeMs: 0,
        unavailable: false,
      };
    };

    // Fire 10 concurrent requests for the same pair.
    const results = await Promise.all(
      Array.from({ length: 10 }, () => cache.coalesce("INR", "XLM", upstream)),
    );

    expect(callCount).toBe(1);
    results.forEach((r) => {
      expect(r).not.toBeNull();
      expect(r!.rate).toBeCloseTo(0.00014);
    });
  });

  it("allows a new upstream call after the previous one settles", async () => {
    const cache = new RateCache();
    let callCount = 0;

    const upstream = async () => {
      callCount += 1;
      return {
        rate: 1,
        source: "x",
        fetchedAt: Date.now(),
        stale: false,
        rateAgeMs: 0,
        unavailable: false,
      };
    };

    await cache.coalesce("EUR", "XLM", upstream);
    await cache.coalesce("EUR", "XLM", upstream);

    // Each sequential request starts its own upstream call.
    expect(callCount).toBe(2);
  });

  it("removes in-flight entry even when upstream throws/returns null", async () => {
    const cache = new RateCache();
    let callCount = 0;

    const upstream = async () => {
      callCount += 1;
      return null;
    };

    const [r1, r2] = await Promise.all([
      cache.coalesce("USD", "XLM", upstream),
      cache.coalesce("USD", "XLM", upstream),
    ]);

    // Both should share the same null result from one call.
    expect(callCount).toBe(1);
    expect(r1).toBeNull();
    expect(r2).toBeNull();

    // After settling, the next call starts fresh.
    await cache.coalesce("USD", "XLM", upstream);
    expect(callCount).toBe(2);
  });
});

describe("RateCache — clear()", () => {
  it("removes all entries", () => {
    const cache = new RateCache();
    const now = Date.now();
    cache.set("INR", "XLM", 1, "x", POLICY, now);
    cache.set("EUR", "XLM", 2, "x", POLICY, now);
    expect(cache.size).toBe(2);
    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.get("INR", "XLM")).toBeNull();
  });
});
