/**
 * CoinGecko exchange-rate provider.
 *
 * Fetches the current XLM price in USD, then converts to the requested fiat
 * pair via the USD bridge. The free-tier `/simple/price` endpoint requires no
 * key and updates approximately every 60 seconds; the optional
 * `COINGECKO_API_KEY` env var is forwarded as a header for pro-tier access
 * without changing any logic.
 *
 * ## Testnet / mainnet parity
 *
 * This provider talks to CoinGecko — an off-chain REST API — not to the
 * Stellar DEX. It therefore returns real market prices on both testnet and
 * mainnet without a special case. The code does not branch on the network.
 *
 * ## Notional size and manipulation resistance
 *
 * The issue asks us to quote a large notional rather than a unit price to
 * reduce the impact of a thin book. CoinGecko's endpoint already aggregates
 * across many venues, so notional quoting is not required here. The
 * Stellar DEX path (if ever used) is where that matters: quoting the DEX for
 * 100 XLM instead of 1 XLM makes it proportionally more expensive for an
 * attacker to move the price into our quote.
 *
 * ## Credentials
 *
 * `COINGECKO_API_KEY` is a server-only env var (no `NEXT_PUBLIC_` prefix).
 * It never reaches the client bundle. The provider is instantiated only inside
 * `lib/fx/rateService.ts`, which is imported only from `app/api/fx/`.
 */

import type { FxProvider } from "../types";

/** CoinGecko coin IDs for assets this app cares about. */
const COINGECKO_IDS: Record<string, string> = {
  XLM: "stellar",
};

const BASE_URL = "https://api.coingecko.com/api/v3";

export class CoinGeckoProvider implements FxProvider {
  readonly name = "coingecko";

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? process.env.COINGECKO_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch `from → to` rate.
   *
   * The provider can only answer pairs where one side is a known crypto asset
   * (currently only XLM) and the other side is any fiat currency that CoinGecko
   * reports. It returns `null` for unsupported pairs rather than throwing.
   *
   * Strategy:
   *   XLM → FIAT: fetch XLM price in `to` directly.
   *   FIAT → XLM: fetch XLM price in `from`, then invert.
   *   Other:       return null (unsupported pair for this provider).
   */
  async fetch(from: string, to: string): Promise<number | null> {
    const fromUp = from.toUpperCase();
    const toUp = to.toUpperCase();

    try {
      if (fromUp === "XLM") {
        const price = await this.fetchXlmPrice(toUp);
        return price;
      }

      if (toUp === "XLM") {
        const price = await this.fetchXlmPrice(fromUp);
        if (price === null || price === 0) return null;
        return 1 / price;
      }

      // Neither side is XLM — this provider cannot answer.
      return null;
    } catch {
      return null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fetches the XLM price in the given vs-currency (e.g. "USD", "INR", "EUR").
   *
   * CoinGecko accepts any fiat code that it knows; unsupported codes result in
   * an empty object rather than an error, which we treat as null.
   */
  private async fetchXlmPrice(vsCurrency: string): Promise<number | null> {
    const coinId = COINGECKO_IDS["XLM"];
    if (!coinId) return null;

    const vsLower = vsCurrency.toLowerCase();
    const url = `${BASE_URL}/simple/price?ids=${coinId}&vs_currencies=${vsLower}`;

    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (this.apiKey) {
      headers["x-cg-pro-api-key"] = this.apiKey;
    }

    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers });
    } catch {
      return null;
    }

    if (!response.ok) return null;

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      return null;
    }

    const price = (body as Record<string, Record<string, number>>)[coinId]?.[vsLower];
    if (typeof price !== "number" || price <= 0) return null;

    return price;
  }
}
