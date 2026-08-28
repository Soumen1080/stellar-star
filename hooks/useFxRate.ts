/**
 * useFxRate — browser-side hook for the FX rate seam (S4).
 *
 * Calls `GET /api/fx/rate?from=<from>&to=<to>` and returns the result. The
 * hook mirrors the service's invariants:
 *
 *   - `unavailable: true` is returned as structured data, never thrown.
 *   - `stale: true` is surfaced to the caller so the UI can show an age
 *     indicator rather than presenting the number as if it were live.
 *   - Multiple simultaneous mounts of the same pair (e.g. in a list of
 *     expenses) make at most one fetch, via a module-level in-flight map.
 *
 * ## Credential safety
 *
 * This hook calls `/api/fx/rate` — a server-side route. No provider API key
 * ever reaches this file or the browser bundle.
 *
 * ## Usage
 *
 * ```tsx
 * const { rate, stale, unavailable, loading } = useFxRate("INR", "XLM");
 *
 * if (loading) return <Spinner />;
 * if (unavailable) return <RateUnavailableBanner />;
 * // rate is a number — use it.
 * ```
 */

"use client";

import { useEffect, useState, useRef } from "react";
import type { RateResult } from "@/lib/fx/types";

export interface UseFxRateResult {
  /** The exchange rate (from → to). Null while loading or unavailable. */
  rate: number | null;
  /** True when the cached value is older than its TTL. */
  stale: boolean;
  /** True when all providers are down. Never blocks — show a warning only. */
  unavailable: boolean;
  /** True during the initial fetch. */
  loading: boolean;
  /** Milliseconds since the rate was fetched. Null while loading. */
  rateAgeMs: number | null;
  /** Which provider produced the rate. */
  source: string | null;
}

// ── Module-level in-flight deduplication ─────────────────────────────────────
//
// Multiple hook instances for the same pair share a single in-flight Promise.
// This is complementary to the server-side coalescing: even if two components
// mount simultaneously and race to call the route, the route's own stampede
// protection ensures only one upstream fetch happens on the server.

const inFlightRequests = new Map<string, Promise<RateResult>>();

async function fetchRate(from: string, to: string): Promise<RateResult> {
  const key = `${from.toUpperCase()}/${to.toUpperCase()}`;

  const existing = inFlightRequests.get(key);
  if (existing) return existing;

  const promise = (async () => {
    try {
      const res = await fetch(`/api/fx/rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
      if (!res.ok) {
        return unavailableResult();
      }
      return (await res.json()) as RateResult;
    } catch {
      return unavailableResult();
    } finally {
      inFlightRequests.delete(key);
    }
  })();

  inFlightRequests.set(key, promise);
  return promise;
}

function unavailableResult(): RateResult {
  return {
    rate: null,
    source: null,
    fetchedAt: null,
    stale: false,
    rateAgeMs: null,
    unavailable: true,
  };
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * @param from Source currency code, e.g. "INR"
 * @param to   Target currency code, e.g. "XLM"
 */
export function useFxRate(from: string, to: string): UseFxRateResult {
  const [result, setResult] = useState<RateResult | null>(null);
  const [loading, setLoading] = useState(true);
  // Prevent state update on unmounted components.
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setLoading(true);

    fetchRate(from, to).then((r) => {
      if (mounted.current) {
        setResult(r);
        setLoading(false);
      }
    });

    return () => {
      mounted.current = false;
    };
  }, [from, to]);

  if (loading || result === null) {
    return {
      rate: null,
      stale: false,
      unavailable: false,
      loading: true,
      rateAgeMs: null,
      source: null,
    };
  }

  return {
    rate: result.rate,
    stale: result.stale,
    unavailable: result.unavailable,
    loading: false,
    rateAgeMs: result.rateAgeMs,
    source: result.source,
  };
}
