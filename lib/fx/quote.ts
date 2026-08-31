/**
 * Client-side consumer of the S4 FX seam.
 *
 * Lives beside the seam rather than inside the form hook because it is pure
 * async logic with no React in it: the expense form, and any future caller,
 * must degrade identically, and a shared implementation is the only way that
 * stays true.
 *
 * The contract it upholds (see lib/fx/rateService.ts): the route always answers
 * HTTP 200 and signals failure as `unavailable: true` with a null rate,
 * precisely so a third-party outage cannot become an exception in the expense
 * submit path. This module preserves that by returning null instead of
 * throwing.
 */

/**
 * A usable exchange-rate quote, or null when the FX service could not price
 * the pair at all.
 *
 * Mirrors the S4 contract in lib/fx/types.ts: the route always answers HTTP
 * 200 and signals failure as `unavailable: true` with a null rate, precisely so
 * that a third-party outage cannot become an exception here. Returning null
 * rather than throwing keeps that design intact at the call site.
 */
interface ExchangeQuote {
  rate: string;
  fetchedAtIso: string;
  stale: boolean;
  rateAgeMs: number;
  source: string | null;
}

/** Renders a rate age as something a person can judge staleness by. */
export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return "an unknown time";
  // Floor, not round: 30 s must read "less than a minute", not "1 minute".
  // Overstating freshness is the direction that misleads.
  const minutes = Math.floor(ageMs / 60_000);
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"}`;
}

/**
 * Fetches a rate for `currency` -> XLM.
 *
 * Returns null for every condition that means "we cannot price this": a
 * transport failure, an `unavailable` response, or a rate that is not a usable
 * positive number. The last check matters most — `unavailable: true` carries
 * `rate: null`, and multiplying by `parseFloat(null)` yields NaN, which would
 * otherwise be persisted as an expense amount of "NaN".
 */
export async function fetchExchangeRate(
  currency: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ExchangeQuote | null> {
  let payload: {
    rate?: number | string | null;
    source?: string | null;
    fetchedAt?: number | null;
    stale?: boolean;
    rateAgeMs?: number | null;
    unavailable?: boolean;
    error?: string;
  };

  try {
    const res = await fetchImpl(
      `/api/fx/rate?from=${encodeURIComponent(currency)}&to=XLM`,
    );
    payload = await res.json();
  } catch {
    // Network failure reaching our own route. Degraded, not fatal.
    return null;
  }

  if (!payload || payload.error || payload.unavailable) return null;

  const rate = Number(payload.rate);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  return {
    rate: String(payload.rate),
    // The route reports `fetchedAt` (epoch ms) — provenance for the quote.
    fetchedAtIso: new Date(payload.fetchedAt ?? Date.now()).toISOString(),
    stale: payload.stale === true,
    rateAgeMs: payload.rateAgeMs ?? 0,
    source: payload.source ?? null,
  };
}
