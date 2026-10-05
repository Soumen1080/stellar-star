/**
 * GET /api/fx/rate
 *
 * Query params:
 *   from  — source currency code, e.g. "INR"
 *   to    — target currency code, e.g. "XLM"
 *
 * Response (HTTP 200 in all cases — see invariant note below):
 * ```json
 * {
 *   "rate": 0.000142,
 *   "source": "coingecko",
 *   "fetchedAt": 1724848800000,
 *   "stale": false,
 *   "rateAgeMs": 4200,
 *   "unavailable": false
 * }
 * ```
 *
 * When all providers are down, `unavailable: true` and `rate: null` are
 * returned with HTTP **200**, not 503. The invariant is: **rate unavailability
 * must never block expense creation**. The client decides how to surface the
 * degraded state (show a warning, disable the converter); the server should
 * not make that choice by returning an error status.
 *
 * ## Credential safety
 *
 * `COINGECKO_API_KEY` and `EXCHANGERATE_API_KEY` are read server-side inside
 * `rateService.ts` → provider constructors. They never appear in this file
 * as exported constants, and they are never given a `NEXT_PUBLIC_` prefix.
 *
 * ## Caching
 *
 * The route sets `Cache-Control: public, s-maxage=30` so CDN edges cache fresh
 * responses. Stale and unavailable responses are not cached.
 *
 * ## Abuse resistance
 *
 * The route is public, and its cache is keyed by the requested pair, so the
 * validation of `from`/`to` is what bounds upstream load. A shape check alone
 * (any 2–6 letters) admits millions of pairs, letting a caller miss the cache on
 * every request and turn each miss into a CoinGecko / ExchangeRate.host call —
 * draining the shared quota and tripping the circuit breakers for all users.
 *
 * Two limits close that:
 *
 *   1. `normalizeCurrency` rejects anything off the `SUPPORTED_CURRENCIES`
 *      whitelist with a 400, *before* the rate service is consulted. The key
 *      space is finite, so the cache can actually cover it.
 *   2. Per-IP rate limiting (60/min) caps how fast one client can walk even the
 *      valid pairs.
 */

import { NextRequest, NextResponse } from "next/server";
import { defaultRateService } from "@/lib/fx/rateService";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Whitelist of supported fiat and crypto currencies to prevent cache-busting DoS. */
const SUPPORTED_CURRENCIES = new Set([
  "XLM",
  "USD",
  "EUR",
  "GBP",
  "INR",
  "USDC",
  "JPY",
  "CAD",
  "AUD",
  "CHF",
  "CNY",
  "NZD",
  "BRL",
  "SGD",
  "HKD",
  "KRW",
  "MXN",
  "SEK",
  "NOK",
]);

/** Validated ISO 4217-like currency code: 2–6 uppercase letters or digits. */
function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z]{2,6}$/.test(code);
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const clientIp = getClientIp(request);
  const rateLimit = await checkRateLimit(`fx:ip:${clientIp}`, 60, 60_000);
  if (!rateLimit.allowed) {
    return jsonError("Too many rate requests. Please try again shortly.", 429);
  }

  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  // Whitelist first: rejecting an unsupported pair must not consume the caller's
  // rate-limit budget, and it is the cheaper of the two checks.
  const fromCode = normalizeCurrency(from);
  const toCode = normalizeCurrency(to);

  if (fromCode === null) {
    return jsonError(
      `Query param "from" must be a supported currency code. Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      400,
    );
  }
  if (toCode === null) {
    return jsonError(
      `Query param "to" must be a supported currency code. Supported: ${SUPPORTED_CURRENCIES.join(", ")}.`,
      400,
    );
  }

  // Identical codes need no provider round-trip, whatever the cache state.
  if (fromCode === toCode) {
    return NextResponse.json(
      {
        rate: 1,
        rateDecimal: "1",
        source: "identity",
        fetchedAt: Date.now(),
        stale: false,
        rateAgeMs: 0,
        unavailable: false,
      },
      { status: 200, headers: { "Cache-Control": "public, s-maxage=30" } },
    );
  }

  // Then rate-limit: caps how fast one client can walk the valid pair space.
  const clientIp = getClientIp(request);
  const ipLimit = await checkRateLimit(
    `fx-rate:ip:${clientIp}`,
    RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!ipLimit.allowed) {
    return NextResponse.json(
      { error: "Too many rate requests. Please try again later." },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil(ipLimit.resetMs / 1000)),
          "Cache-Control": "no-store",
        },
      },
    );
  }

  const upperFrom = from.toUpperCase();
  const upperTo = to.toUpperCase();

  if (!SUPPORTED_CURRENCIES.has(upperFrom) || !SUPPORTED_CURRENCIES.has(upperTo)) {
    return jsonError(
      `Unsupported currency code. Supported: ${Array.from(SUPPORTED_CURRENCIES).join(", ")}`,
      400,
    );
  }

  // getRate never throws — it degrades to { unavailable: true }.
  const result = await defaultRateService.getRate(upperFrom, upperTo);

  // Fresh results may be cached at the CDN edge.
  const cacheControl =
    result.unavailable || result.stale
      ? "no-store"
      : "public, s-maxage=30, stale-while-revalidate=30";

  return NextResponse.json(result, {
    status: 200,
    headers: { "Cache-Control": cacheControl },
  });
}
