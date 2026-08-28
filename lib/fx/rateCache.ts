/**
 * Two-level in-process cache with stampede protection.
 *
 * ## Two-level cache
 *
 *   Fresh tier  — age < ttlMs          → served immediately, no upstream call.
 *   Stale tier  — ttlMs ≤ age < maxStaleMs → served with `stale: true`.
 *   Miss        — age ≥ maxStaleMs, or no entry → upstream call required.
 *
 * ## Stampede protection
 *
 * Twenty simultaneous form mounts must not become twenty upstream calls. The
 * cache stores in-flight `Promise`s keyed by pair. Every concurrent request
 * for the same pair joins the existing promise rather than starting a new one.
 * The promise is removed from the in-flight map once it settles (success or
 * failure) so the next request after a failure starts fresh.
 *
 * ## Key
 *
 * Cache keys are `"FROM/TO"` in uppercase, e.g. `"INR/XLM"`. Normalisation
 * is internal so callers cannot accidentally use different keys for the same
 * pair.
 */

import type { CacheEntry, FreshnessPolicy, RateResult } from "./types";

function cacheKey(from: string, to: string): string {
  return `${from.toUpperCase()}/${to.toUpperCase()}`;
}

export class RateCache {
  private entries = new Map<string, CacheEntry>();
  // In-flight requests keyed by pair. Stores a Promise that resolves to
  // `RateResult | null`, where null means the upstream call failed entirely.
  private inFlight = new Map<string, Promise<RateResult | null>>();

  /**
   * Look up a pair in the cache.
   *
   * Returns:
   *   - Fresh `RateResult` (stale: false) if within TTL.
   *   - Stale `RateResult` (stale: true, rateAgeMs) if within maxStale.
   *   - `null` if the entry does not exist or has expired beyond maxStale.
   */
  get(from: string, to: string, now: number = Date.now()): RateResult | null {
    const key = cacheKey(from, to);
    const entry = this.entries.get(key);
    if (!entry) return null;

    const ageMs = now - entry.fetchedAt;

    if (ageMs >= entry.maxStaleMs) {
      // Fully expired — evict and return miss.
      this.entries.delete(key);
      return null;
    }

    const stale = ageMs >= entry.ttlMs;
    return {
      rate: entry.rate,
      source: entry.source,
      fetchedAt: entry.fetchedAt,
      stale,
      rateAgeMs: ageMs,
      unavailable: false,
    };
  }

  /** Store a fresh result in the cache. */
  set(
    from: string,
    to: string,
    rate: number,
    source: string,
    policy: FreshnessPolicy,
    fetchedAt: number = Date.now(),
  ): void {
    const key = cacheKey(from, to);
    this.entries.set(key, {
      rate,
      source,
      fetchedAt,
      ttlMs: policy.ttlMs,
      maxStaleMs: policy.maxStaleMs,
    });
  }

  /**
   * Stampede protection: coalesce concurrent requests for the same pair.
   *
   * If there is already an in-flight request for `key`, return its promise.
   * Otherwise, call `fn`, register its promise, and clean up on completion.
   */
  coalesce(
    from: string,
    to: string,
    fn: () => Promise<RateResult | null>,
  ): Promise<RateResult | null> {
    const key = cacheKey(from, to);

    const existing = this.inFlight.get(key);
    if (existing) return existing;

    const promise = fn().finally(() => {
      // Remove from in-flight map once settled so the next request after a
      // failure starts a fresh upstream call rather than re-joining a settled
      // (failed) promise.
      this.inFlight.delete(key);
    });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Evict all entries — useful in tests. */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }

  /** Number of cached entries — useful in tests. */
  get size(): number {
    return this.entries.size;
  }
}
