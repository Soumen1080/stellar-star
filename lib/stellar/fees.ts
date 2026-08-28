/**
 * Adaptive fee strategy.
 *
 * `TX_BASE_FEE` was a hardcoded 100 stroops. That is the protocol minimum and
 * it works on a quiet network, but under mainnet surge pricing it is far too
 * low: the network rejects the transaction with `tx_insufficient_fee` and the
 * user loses a round-trip (and, worse, a mistaken retry can double-spend a
 * quote). This module replaces the constant with a value derived from the
 * network's own observed fee distribution.
 *
 * Horizon's `/fee_stats` reports, per ledger, the fees transactions actually
 * paid. We take the median accepted fee (`fee_charged.p50_accepted_fee`) and
 * add the ledger's base fee — the floor the protocol charges per operation.
 * That clears normal surge and, because we clamp to a sane ceiling, never
 * produces a runaway fee. Results are cached briefly so back-to-back payments
 * in one session don't each hammer `/fee_stats`.
 */

import { HORIZON_URL } from "@/lib/utils/constants";

/** Protocol-minimum fee per operation, in stroops (0.00001 XLM). */
export const FEE_MIN_STROOPS = 100;

/** Ceiling so a pathological fee_stats response can never produce a huge fee. */
export const FEE_MAX_STROOPS = 1_000_000; // 0.1 XLM

/** How long a fetched fee suggestion stays valid before we re-poll. */
const CACHE_TTL_MS = 20_000;

export interface RawFeeStats {
  last_ledger_base_fee?: string;
  fee_charged?: Record<string, string | undefined>;
  // Some responses wrap everything under a `fee_charged` object; others also
  // expose top-level aggregates. We only need the two below.
  p50_accepted_fee?: string;
}

export async function fetchFeeStats(
  horizonUrl: string = HORIZON_URL,
  fetchImpl: typeof fetch = fetch
): Promise<RawFeeStats | null> {
  try {
    const res = await fetchImpl(`${horizonUrl}/fee_stats`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as RawFeeStats;
  } catch {
    // Network unreachable / CORS / timeout — fall back, never throw.
    return null;
  }
}

/**
 * Computes a per-operation fee (stroops) from fee stats.
 *
 * Returns `fallback` when stats are missing or unparseable, so callers always
 * get a usable number. The result is the *per-operation* fee: the SDK multiplies
 * it by the operation count to get the total, so multi-operation transactions
 * scale their total fee naturally under surge.
 */
export function suggestBaseFee(stats?: RawFeeStats | null, fallback: number = FEE_MIN_STROOPS): number {
  if (!stats) return fallback;

  const base = Number(stats.last_ledger_base_fee);
  const p50 = Number(stats.fee_charged?.p50_accepted_fee ?? stats.p50_accepted_fee);

  if (!Number.isFinite(base) || !Number.isFinite(p50)) return fallback;

  const suggested = Math.ceil(p50) + Math.ceil(base);
  if (!Number.isFinite(suggested) || suggested <= 0) return fallback;

  return Math.min(Math.max(suggested, FEE_MIN_STROOPS), FEE_MAX_STROOPS);
}

interface FeeCache {
  value: number;
  at: number;
}

let feeCache: FeeCache | null = null;

export interface SuggestFeeOptions {
  horizonUrl?: string;
  fallback?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Resolves to a per-operation fee string suitable for `TransactionBuilder`.
 * Caches the suggestion for `CACHE_TTL_MS` to avoid per-transaction polling.
 */
export async function getSuggestedBaseFee(opts: SuggestFeeOptions = {}): Promise<string> {
  const fallback = opts.fallback ?? FEE_MIN_STROOPS;
  const now = opts.now ?? Date.now;

  if (feeCache && now() - feeCache.at < CACHE_TTL_MS) {
    return String(feeCache.value);
  }

  const stats = await fetchFeeStats(opts.horizonUrl, opts.fetchImpl ?? fetch);
  const fee = suggestBaseFee(stats, fallback);
  feeCache = { value: fee, at: now() };
  return String(fee);
}

/** Test seam: clears the in-memory fee cache. */
export function clearFeeCache(): void {
  feeCache = null;
}
