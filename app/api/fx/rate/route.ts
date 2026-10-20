/**
 * GET /api/fx/rate
 *
 * Query params:
 *   from         — source currency code, e.g. "INR"
 *   to           — target currency code, e.g. "XLM"
 *   corroborate  — "1" to cross-check every provider (used when a user locks a
 *                  quote for an expense; see FxRateService.getCorroboratedRate)
 *
 * Response (HTTP 200 in all cases — see invariant note below):
 * ```json
 * {
 *   "rate": 0.000142,
 *   "rateDecimal": "0.000142",
 *   "source": "coingecko",
 *   "fetchedAt": 1724848800000,
 *   "stale": false,
 *   "rateAgeMs": 4200,
 *   "unavailable": false,
 *   "providers": [{ "source": "coingecko", "rate": "0.000142" }],
 *   "spreadBps": 12,
 *   "disagreement": false
 * }
 * ```
 *
 * When all providers are down, `unavailable: true` and `rate: null` are
 * returned with HTTP **200**, not 503: the client decides how to surface the
 * degraded state, and a user can always enter the amount in XLM directly.
 *
 * ## Credential safety
 *
 * Provider API keys are read server-side inside the provider constructors and
 * never carry a `NEXT_PUBLIC_` prefix.
 *
 * ## Caching & abuse resistance
 *
 * Fresh, uncorroborated responses may be cached at the edge for 30 s. Stale,
 * unavailable and corroborated responses are never cached. Both codes must be
 * on the whitelist (lib/fx/currencies.ts) before the per-IP rate limit is
 * consulted, so junk pairs cannot bust the cache or burn a caller's budget.
 */

import { NextRequest, NextResponse } from "next/server";
import { defaultRateService } from "@/lib/fx/rateService";
import { normalizeCurrency, SUPPORTED_CURRENCIES } from "@/lib/fx/currencies";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RATE_LIMIT_MAX = 60;
const RATE_LIMIT_WINDOW_MS = 60_000;
/** Corroboration calls every provider, so it gets a tighter budget. */
const CORROBORATE_LIMIT_MAX = 20;

function jsonError(message: string, status: number, headers: Record<string, string> = {}) {
  return NextResponse.json(
    { error: message },
    { status, headers: { "Cache-Control": "no-store", ...headers } },
  );
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const fromCode = normalizeCurrency(searchParams.get("from"));
  const toCode = normalizeCurrency(searchParams.get("to"));
  const corroborate = searchParams.get("corroborate") === "1";

  const supported = SUPPORTED_CURRENCIES.join(", ");
  if (fromCode === null) {
    return jsonError(`Query param "from" must be a supported currency code. Supported: ${supported}.`, 400);
  }
  if (toCode === null) {
    return jsonError(`Query param "to" must be a supported currency code. Supported: ${supported}.`, 400);
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

  const clientIp = getClientIp(request);
  const limit = await checkRateLimit(
    `fx-rate:${corroborate ? "corroborate" : "ip"}:${clientIp}`,
    corroborate ? CORROBORATE_LIMIT_MAX : RATE_LIMIT_MAX,
    RATE_LIMIT_WINDOW_MS,
  );
  if (!limit.allowed) {
    return jsonError("Too many rate requests. Please try again later.", 429, {
      "Retry-After": String(Math.ceil(limit.resetMs / 1000)),
    });
  }

  // Neither method throws — both degrade to { unavailable: true }.
  const result = corroborate
    ? await defaultRateService.getCorroboratedRate(fromCode, toCode)
    : await defaultRateService.getRate(fromCode, toCode);

  const cacheControl =
    corroborate || result.unavailable || result.stale
      ? "no-store"
      : "public, s-maxage=30, stale-while-revalidate=30";

  return NextResponse.json(result, { status: 200, headers: { "Cache-Control": cacheControl } });
}
