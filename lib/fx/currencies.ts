/**
 * Supported currency whitelist for the FX seam.
 *
 * ## Why a whitelist rather than a shape check
 *
 * `/api/fx/rate` is public and its in-memory cache is keyed by the requested
 * pair. A pattern check like `/^[A-Za-z]{2,6}$/` admits millions of codes, so a
 * caller cycling `?from=AAAA&to=BBBB` misses the cache on every request and each
 * miss becomes an upstream call to CoinGecko / ExchangeRate.host. That burns the
 * shared API quota and trips the circuit breakers for every user — the cache and
 * breakers are process-wide singletons, so one abusive client degrades everyone.
 *
 * Bounding the key space to a fixed set makes the cache effective by
 * construction: there is a finite number of distinct pairs to warm, so a flood
 * of valid requests is absorbed by the cache instead of reaching a provider.
 *
 * ## What belongs here
 *
 * Only codes the providers can actually answer (see `lib/fx/providers/`):
 *
 *   - XLM, routed by CoinGecko directly and by ExchangeRate.host via USD.
 *   - Fiat codes CoinGecko accepts as a `vs_currency` and ExchangeRate.host
 *     publishes — the majors, plus the currencies this app's UI offers.
 *
 * Adding a code here is the single step needed to support a new currency; it is
 * deliberately a code change rather than config so that the upstream providers'
 * ability to answer the pair is considered at review time.
 *
 * `USDC` is accepted and normalised to `USD`: it is a dollar-pegged stablecoin
 * that neither provider quotes under that ticker, and treating it as USD is both
 * what the UI means by it and what keeps the two from occupying separate cache
 * entries for the same rate.
 */

/** Crypto assets quotable by the provider chain. */
export const SUPPORTED_CRYPTO = ["XLM"] as const;

/**
 * Fiat currencies quotable by the provider chain.
 *
 * Kept to codes with real coverage at both providers. INR, USD, EUR and GBP are
 * the ones this app's UI surfaces today; the rest are majors included so that a
 * user selecting a common home currency is not rejected.
 */
export const SUPPORTED_FIAT = [
  "USD",
  "EUR",
  "GBP",
  "INR",
  "JPY",
  "AUD",
  "CAD",
  "CHF",
  "CNY",
  "SGD",
  "HKD",
  "NZD",
  "AED",
  "SAR",
  "ZAR",
  "BRL",
  "MXN",
  "NGN",
  "KES",
  "IDR",
  "MYR",
  "PHP",
  "THB",
  "VND",
  "TRY",
  "PLN",
  "SEK",
  "NOK",
  "DKK",
  "CZK",
  "HUF",
  "ILS",
  "KRW",
  "TWD",
  "RUB",
  "UAH",
  "EGP",
  "PKR",
  "BDT",
  "LKR",
  "NPR",
  "ARS",
  "CLP",
  "COP",
  "PEN",
] as const;

/**
 * Aliases normalised to a canonical code before any lookup.
 *
 * Collapsing these prevents two cache entries for one economic rate.
 */
const CURRENCY_ALIASES: Record<string, string> = {
  USDC: "USD",
  USDT: "USD",
};

/** Every code accepted on the wire, canonical and alias alike. */
const SUPPORTED_SET: ReadonlySet<string> = new Set<string>([
  ...SUPPORTED_CRYPTO,
  ...SUPPORTED_FIAT,
  ...Object.keys(CURRENCY_ALIASES),
]);

/** Sorted list of accepted codes — used in error messages and tests. */
export const SUPPORTED_CURRENCIES: readonly string[] = Object.freeze(
  [...SUPPORTED_SET].sort(),
);

/**
 * Normalises a client-supplied code to its canonical, uppercase form.
 *
 * Returns `null` for anything not on the whitelist, which is the signal to
 * reject the request before a provider is ever consulted. Non-string input is
 * rejected too, since query params arrive untyped.
 */
export function normalizeCurrency(code: unknown): string | null {
  if (typeof code !== "string") return null;

  const trimmed = code.trim().toUpperCase();
  if (!SUPPORTED_SET.has(trimmed)) return null;

  return CURRENCY_ALIASES[trimmed] ?? trimmed;
}

/** True when `code` is a currency the provider chain can be asked about. */
export function isSupportedCurrency(code: unknown): code is string {
  return normalizeCurrency(code) !== null;
}

/** True when the pair involves a crypto asset (drives the freshness policy). */
export function isCryptoCurrency(code: string): boolean {
  return (SUPPORTED_CRYPTO as readonly string[]).includes(code.toUpperCase());
}
