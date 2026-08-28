/**
 * ExchangeRate.host provider — fiat bridge.
 *
 * CoinGecko covers fiat pairs that are directly available for XLM (most major
 * currencies). This provider covers the remainder by bridging through USD:
 *
 *   fiat → XLM  =  (fiat/USD rate)  × (1 / XLM/USD rate)
 *   XLM → fiat  =  (XLM/USD rate)   × (USD/fiat rate)
 *
 * ExchangeRate.host is a free, public API that aggregates ECB and other
 * authoritative fiat rate sources. It publishes once per day, making it
 * appropriate for the long-TTL fiat tier (3600 s TTL / 86400 s max-stale).
 *
 * ## No credentials required
 *
 * The free tier of ExchangeRate.host is used with no API key. If
 * `EXCHANGERATE_API_KEY` is set, it is forwarded for higher-rate-limit tiers.
 *
 * ## Testnet parity
 *
 * Same reasoning as the CoinGecko provider: this talks to an off-chain API.
 * No testnet special-casing.
 */

import type { FxProvider } from "../types";

const BASE_URL = "https://api.exchangerate.host";

export class ExchangeRateProvider implements FxProvider {
  readonly name = "exchangerate-host";

  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: { apiKey?: string; fetchImpl?: typeof fetch } = {}) {
    this.apiKey = options.apiKey ?? process.env.EXCHANGERATE_API_KEY;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /**
   * Fetch `from → to` rate.
   *
   * Both sides must be fiat or one side must be bridgeable through USD with
   * help from an XLM/USD signal. If neither side is fiat and neither side is
   * XLM, this provider cannot help and returns null.
   *
   * Strategy:
   *   FIAT → XLM:    fetch FIAT/USD, fetch XLM/USD, invert XLM/USD, multiply.
   *   XLM → FIAT:    fetch XLM/USD from ExchangeRate (USD-denominated price
   *                  is unavailable here; delegate to CoinGecko for XLM side).
   *   FIAT → FIAT:   direct ExchangeRate lookup.
   *   Other:         null (unsupported).
   *
   * Note: For XLM → FIAT, this provider returns null and lets the service
   * chain fall through to CoinGecko (which handles it directly). This
   * avoids duplicating the XLM price source.
   */
  async fetch(from: string, to: string): Promise<number | null> {
    const fromUp = from.toUpperCase();
    const toUp = to.toUpperCase();

    try {
      if (fromUp === "XLM" || toUp === "XLM") {
        // Hybrid: need fiat/USD and XLM/USD. Fetch the fiat side here and
        // return null — the service will then compose from multiple providers.
        // A simpler approach: fetch FIAT/USD rate and also fetch XLM/USD
        // from ExchangeRate's live feed if it is available.
        return await this.fetchViaUsdBridge(fromUp, toUp);
      }

      // Pure fiat → fiat.
      return await this.fetchFiatToFiat(fromUp, toUp);
    } catch {
      return null;
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Fetches a fiat → fiat rate directly.
   */
  private async fetchFiatToFiat(from: string, to: string): Promise<number | null> {
    const url = this.buildUrl(`/latest?base=${from}&symbols=${to}`);

    const body = await this.get(url);
    if (!body) return null;

    const rate = (body as any).rates?.[to];
    if (typeof rate !== "number" || rate <= 0) return null;
    return rate;
  }

  /**
   * Bridges a pair involving XLM through USD.
   *
   * FIAT → XLM: rate = (USD/XLM) × (FIAT/USD)
   *              = 1/xlmUsd × fiατUsd
   * XLM → FIAT: rate = xlmUsd × (USD/FIAT)
   *              = xlmUsd / fiatUsd
   *
   * Fetches the XLM/USD rate from the live endpoint, and the fiat/USD rate from
   * the latest endpoint. Returns null if either sub-fetch fails.
   */
  private async fetchViaUsdBridge(from: string, to: string): Promise<number | null> {
    const fiatCode = from === "XLM" ? to : from;

    // Fetch fiat/USD rate.
    const fiatUsd = await this.fetchFiatUsd(fiatCode);
    if (fiatUsd === null || fiatUsd === 0) return null;

    // Fetch XLM/USD via a crypto-aware endpoint. ExchangeRate.host supports
    // XLM as a currency code on its live endpoint.
    const xlmUsd = await this.fetchXlmUsd();
    if (xlmUsd === null || xlmUsd === 0) return null;

    if (from === "XLM") {
      // XLM → FIAT = XLM/USD × USD/FIAT = xlmUsd / fiatUsd
      return xlmUsd / fiatUsd;
    } else {
      // FIAT → XLM = FIAT/USD / XLM/USD = fiatUsd / xlmUsd
      return fiatUsd / xlmUsd;
    }
  }

  /** Fetches the fiat currency's value in USD. */
  private async fetchFiatUsd(fiat: string): Promise<number | null> {
    if (fiat === "USD") return 1;
    const url = this.buildUrl(`/latest?base=${fiat}&symbols=USD`);
    const body = await this.get(url);
    if (!body) return null;
    const rate = (body as any).rates?.["USD"];
    if (typeof rate !== "number" || rate <= 0) return null;
    return rate;
  }

  /** Fetches XLM/USD from ExchangeRate.host's live crypto endpoint. */
  private async fetchXlmUsd(): Promise<number | null> {
    // ExchangeRate.host supports cryptocurrency rates via the /live endpoint.
    const url = this.buildUrl(`/live?base=XLM&symbols=USD`);
    const body = await this.get(url);
    if (!body) return null;
    // Response shape: { quotes: { XLMUSD: number } }
    const quotes = (body as any).quotes;
    const rate = quotes?.["XLMUSD"] ?? (body as any).rates?.["USD"];
    if (typeof rate !== "number" || rate <= 0) return null;
    return rate;
  }

  private buildUrl(path: string): string {
    if (this.apiKey) {
      const sep = path.includes("?") ? "&" : "?";
      return `${BASE_URL}${path}${sep}access_key=${this.apiKey}`;
    }
    return `${BASE_URL}${path}`;
  }

  private async get(url: string): Promise<unknown | null> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Accept: "application/json" } });
    } catch {
      return null;
    }

    if (!response.ok) return null;

    try {
      return await response.json();
    } catch {
      return null;
    }
  }
}
