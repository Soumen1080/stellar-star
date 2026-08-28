/**
 * Seam S4 — fiat ↔ XLM exchange rates.
 *
 * The single design invariant that shapes everything here: **rate unavailability
 * must never block expense creation**. An `unavailable: true` result is a
 * designed state, not an error branch. The caller decides what to do with it
 * (show a warning, disable the converter) — this module never panics on the
 * caller's behalf.
 *
 * Provenance fields (`source`, `fetchedAt`) are mandatory on every non-null
 * result so the UI can surface "price from CoinGecko, 45 s ago" rather than
 * an anonymous number.
 */

// ── Result type ───────────────────────────────────────────────────────────────

/**
 * Everything the caller needs to decide whether to trust a rate.
 *
 * A result is exactly one of:
 *   - Fresh:       `rate !== null`, `stale: false`, `unavailable: false`
 *   - Stale:       `rate !== null`, `stale: true`,  `unavailable: false`
 *   - Unavailable: `rate: null`,    `stale: false`,  `unavailable: true`
 *
 * The degraded paths are explicit fields rather than thrown errors so that a
 * `try/catch` around the service is never needed.
 */
export interface RateResult {
  /**
   * How many units of `to` one unit of `from` buys.
   * `null` only when `unavailable` is true.
   */
  rate: number | null;

  /** Which provider produced this rate. */
  source: string | null;

  /** Epoch-ms when the upstream fetch completed. */
  fetchedAt: number | null;

  /**
   * True when the cache entry is older than its TTL but younger than its
   * maxStale window. Never true when `rate` is null.
   */
  stale: boolean;

  /**
   * Milliseconds since the rate was fetched. Available when `rate !== null`.
   * Lets the UI show "45 s ago" so the user can judge how fresh the price is.
   */
  rateAgeMs: number | null;

  /**
   * True when every provider failed and no usable cache entry exists.
   * The caller should show a warning but must not block form submission.
   */
  unavailable: boolean;
}

// ── Provider interface ────────────────────────────────────────────────────────

/**
 * The contract every rate provider must satisfy.
 *
 * `fetch` returns `null` when the provider is unable to supply a rate (network
 * error, bad response, empty body). It must never throw — the service layer
 * treats `null` as "try next provider".
 */
export interface FxProvider {
  /** Stable identifier used in `RateResult.source` and circuit-breaker keys. */
  readonly name: string;

  /**
   * Fetch the exchange rate from `from` to `to`.
   *
   * Returns `null` on any failure. Implementations must catch all exceptions
   * internally and convert them to `null` — the service never wraps providers
   * in its own try/catch.
   */
  fetch(from: string, to: string): Promise<number | null>;
}

// ── Cache entry ───────────────────────────────────────────────────────────────

/** An entry stored in the two-level in-process cache. */
export interface CacheEntry {
  rate: number;
  source: string;
  fetchedAt: number;
  /** TTL in milliseconds; entries younger than this are "fresh". */
  ttlMs: number;
  /** Maximum age before an entry is evicted entirely. */
  maxStaleMs: number;
}

// ── Circuit-breaker state ─────────────────────────────────────────────────────

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerConfig {
  /** Consecutive failures before the circuit opens. */
  failureThreshold: number;
  /** Milliseconds the circuit stays OPEN before moving to HALF_OPEN. */
  resetTimeoutMs: number;
}

// ── Provider freshness config ─────────────────────────────────────────────────

/**
 * Freshness policy for a specific currency pair.
 *
 * Fiat rates (e.g. INR/USD from ECB-sourced feeds) are published daily and can
 * be cached for hours. Crypto rates (XLM/USD) move by the second and need a
 * much shorter TTL. One TTL for both is wrong in one direction or the other.
 */
export interface FreshnessPolicy {
  /** How long a fresh entry is served without re-fetching. */
  ttlMs: number;
  /** Maximum age at which a stale entry is still served (with stale flag). */
  maxStaleMs: number;
}
