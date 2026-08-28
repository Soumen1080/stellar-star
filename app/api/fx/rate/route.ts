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
 */

import { NextRequest, NextResponse } from "next/server";
import { defaultRateService } from "@/lib/fx/rateService";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Validated ISO 4217-like currency code: 2–6 uppercase letters or digits. */
function isValidCurrencyCode(code: unknown): code is string {
  return typeof code === "string" && /^[A-Za-z]{2,6}$/.test(code);
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const from = searchParams.get("from");
  const to = searchParams.get("to");

  if (!isValidCurrencyCode(from)) {
    return jsonError('Query param "from" must be a 2–6 letter currency code.', 400);
  }
  if (!isValidCurrencyCode(to)) {
    return jsonError('Query param "to" must be a 2–6 letter currency code.', 400);
  }

  // getRate never throws — it degrades to { unavailable: true }.
  const result = await defaultRateService.getRate(from.toUpperCase(), to.toUpperCase());

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
