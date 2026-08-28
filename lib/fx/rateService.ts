/**
 * Seam S4 — FX Rate Service.
 *
 * The orchestration layer between the cache, the circuit breakers, and the
 * provider chain. This is the only file the API route and the client hook
 * need to import.
 *
 * ## Invariants enforced here
 *
 * 1. Rate unavailability never blocks expense creation.
 *    `getRate` never throws. On total failure it returns
 *    `{ rate: null, unavailable: true }`.
 *
 * 2. A stale value is served only when explicitly marked stale, with its age.
 *    `stale: true` + `rateAgeMs` appear together on every stale result.
 *    They never appear on a fresh result.
 *
 * 3. N concurrent identical requests produce at most one upstream call.
 *    Handled by `RateCache.coalesce`.
 *
 * 4. A failing provider is bypassed without repeatedly paying its timeout.
 *    Each provider has its own `CircuitBreaker`.
 *
 * 5. Every quote carries provenance.
 *    `source` and `fetchedAt` are mandatory on every non-null result.
 *
 * ## Freshness policy
 *
 * Crypto rates (XLM/USD) move by the second; fiat rates (INR/USD) are
 * published at most daily by authoritative sources such as the ECB. One TTL
 * for both would be wrong in one direction or the other, so we use:
 *
 *   Crypto pair (one side is XLM): TTL = 60 s,  maxStale = 300 s
 *   Fiat / fiat pair:              TTL = 3600 s, maxStale = 86400 s
 *
 * ## Singleton usage
 *
 * The module exports a shared singleton (`defaultRateService`) that the API
 * route uses. Tests instantiate their own `FxRateService` so they can inject
 * mocked providers and clocks.
 */

import type { FxProvider, FreshnessPolicy, RateResult } from "./types";
import { RateCache } from "./rateCache";
import { CircuitBreaker } from "./circuitBreaker";
import { CoinGeckoProvider } from "./providers/coingecko";
import { ExchangeRateProvider } from "./providers/exchangerate";

// ── Freshness policies ────────────────────────────────────────────────────────

/** Crypto rates move fast — 60 s fresh, 5 min stale tolerated. */
const CRYPTO_POLICY: FreshnessPolicy = {
  ttlMs: 60_000,
  maxStaleMs: 300_000,
};

/**
 * Fiat/fiat rates are published daily (ECB, central bank feeds). Three minutes
 * of freshness is generous; a full day of stale is acceptable.
 */
const FIAT_POLICY: FreshnessPolicy = {
  ttlMs: 3_600_000,
  maxStaleMs: 86_400_000,
};

function policyFor(from: string, to: string): FreshnessPolicy {
  const fromUp = from.toUpperCase();
  const toUp = to.toUpperCase();
  return fromUp === "XLM" || toUp === "XLM" ? CRYPTO_POLICY : FIAT_POLICY;
}

// ── Service ───────────────────────────────────────────────────────────────────

export interface FxRateServiceOptions {
  providers?: FxProvider[];
  /** Override for tests — avoids a module-level singleton clock capture. */
  now?: () => number;
}

export class FxRateService {
  private readonly cache: RateCache;
  private readonly breakers: Map<string, CircuitBreaker>;
  private readonly providers: FxProvider[];
  private readonly now: () => number;

  constructor(options: FxRateServiceOptions = {}) {
    this.cache = new RateCache();
    this.providers = options.providers ?? [
      new CoinGeckoProvider(),
      new ExchangeRateProvider(),
    ];
    this.now = options.now ?? (() => Date.now());

    // One circuit breaker per provider, keyed by name.
    this.breakers = new Map(
      this.providers.map((p) => [p.name, new CircuitBreaker(p.name)]),
    );
  }

  /**
   * Returns the exchange rate from `from` to `to`.
   *
   * Never throws. Degrades through:
   *   1. Fresh cache hit  → returned immediately.
   *   2. Provider chain   → first successful provider wins; result cached.
   *   3. Stale cache hit  → returned with `stale: true`.
   *   4. Total failure    → `{ rate: null, unavailable: true }`.
   *
   * Steps 2–4 are collapsed into a single coalesced upstream attempt so that
   * concurrent requests for the same pair share one fetch.
   */
  async getRate(from: string, to: string): Promise<RateResult> {
    const now = this.now();

    // 1. Fresh cache hit.
    const cached = this.cache.get(from, to, now);
    if (cached && !cached.stale) return cached;

    // 2–4: coalesce concurrent upstream attempts.
    const result = await this.cache.coalesce(from, to, () =>
      this.fetchFromProviders(from, to),
    );

    if (result && !result.unavailable) return result;

    // 3. Stale cache hit as last resort.
    if (cached && cached.stale) return cached;

    // 4. Total failure.
    return { rate: null, source: null, fetchedAt: null, stale: false, rateAgeMs: null, unavailable: true };
  }

  /**
   * Walks the provider chain, returning the first successful result.
   *
   * Each provider is wrapped in its circuit breaker. A null result (provider
   * failure or breaker open) causes the chain to move to the next provider.
   */
  private async fetchFromProviders(from: string, to: string): Promise<RateResult | null> {
    const policy = policyFor(from, to);

    for (const provider of this.providers) {
      const breaker = this.breakers.get(provider.name)!;
      const rate = await breaker.call(() => provider.fetch(from, to));

      if (rate !== null) {
        const fetchedAt = this.now();
        this.cache.set(from, to, rate, provider.name, policy, fetchedAt);
        return {
          rate,
          source: provider.name,
          fetchedAt,
          stale: false,
          rateAgeMs: 0,
          unavailable: false,
        };
      }
    }

    // All providers failed.
    return null;
  }

  /**
   * Exposes circuit-breaker state — useful for health checks and tests.
   */
  getBreakerState(providerName: string) {
    return this.breakers.get(providerName)?.currentState ?? null;
  }

  /** Clears the cache — useful in tests. */
  clearCache(): void {
    this.cache.clear();
  }
}

// ── Singleton ─────────────────────────────────────────────────────────────────

/**
 * The shared service instance used by `app/api/fx/rate/route.ts`.
 *
 * Using a module-level singleton means the cache and circuit breakers survive
 * across requests within the same server process — exactly what we want for
 * stampede protection and breaker state.
 */
export const defaultRateService = new FxRateService();
