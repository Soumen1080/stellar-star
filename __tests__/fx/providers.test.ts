/**
 * Individual provider tests — CoinGecko and ExchangeRate.host.
 *
 * Each provider is tested in isolation with a mock `fetch` implementation.
 * The invariant under test: every provider must return `null` on any failure
 * (network error, non-2xx response, unexpected body shape) rather than
 * throwing. The service layer relies on this — it never wraps provider calls
 * in its own try/catch.
 */

import { CoinGeckoProvider } from "@/lib/fx/providers/coingecko";
import { ExchangeRateProvider } from "@/lib/fx/providers/exchangerate";

// ── Helpers ───────────────────────────────────────────────────────────────────

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(status: number): Response {
  return new Response("error", { status });
}

// ── CoinGecko ─────────────────────────────────────────────────────────────────

describe("CoinGeckoProvider", () => {
  it("returns the XLM price in a fiat currency (XLM → FIAT)", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ stellar: { inr: 12.5 } })),
    });
    const rate = await provider.fetch("XLM", "INR");
    expect(rate).toBeCloseTo(12.5);
  });

  it("inverts the XLM price for FIAT → XLM", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ stellar: { inr: 10 } })),
    });
    const rate = await provider.fetch("INR", "XLM");
    expect(rate).toBeCloseTo(0.1); // 1 / 10
  });

  it("returns null for a pair where neither side is XLM", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({})),
    });
    const rate = await provider.fetch("INR", "EUR");
    expect(rate).toBeNull();
  });

  it("returns null on HTTP 500", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () => Promise.resolve(errorResponse(500)),
    });
    const rate = await provider.fetch("XLM", "INR");
    expect(rate).toBeNull();
  });

  it("returns null on HTTP 429 (rate limit)", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () => Promise.resolve(errorResponse(429)),
    });
    const rate = await provider.fetch("XLM", "USD");
    expect(rate).toBeNull();
  });

  it("returns null on network error (fetch throws)", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () => Promise.reject(new Error("network failure")),
    });
    const rate = await provider.fetch("XLM", "INR");
    expect(rate).toBeNull();
  });

  it("returns null when body has no price for the requested currency", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ stellar: {} })), // Missing "inr" key.
    });
    const rate = await provider.fetch("XLM", "INR");
    expect(rate).toBeNull();
  });

  it("returns null when the price is zero", async () => {
    const provider = new CoinGeckoProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ stellar: { usd: 0 } })),
    });
    const rate = await provider.fetch("INR", "XLM");
    expect(rate).toBeNull(); // Division by zero guarded.
  });

  it("includes the API key header when configured", async () => {
    let capturedHeaders: Record<string, string> = {};
    const provider = new CoinGeckoProvider({
      apiKey: "my-secret-key",
      fetchImpl: (url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return Promise.resolve(okResponse({ stellar: { usd: 0.1 } }));
      },
    });
    await provider.fetch("XLM", "USD");
    expect(capturedHeaders["x-cg-pro-api-key"]).toBe("my-secret-key");
  });

  it("does not include the API key header when not configured", async () => {
    let capturedHeaders: Record<string, string> = {};
    const provider = new CoinGeckoProvider({
      fetchImpl: (url, init) => {
        capturedHeaders = (init?.headers as Record<string, string>) ?? {};
        return Promise.resolve(okResponse({ stellar: { usd: 0.1 } }));
      },
    });
    await provider.fetch("XLM", "USD");
    expect(capturedHeaders["x-cg-pro-api-key"]).toBeUndefined();
  });
});

// ── ExchangeRate.host ─────────────────────────────────────────────────────────

describe("ExchangeRateProvider", () => {
  it("returns a fiat/fiat rate directly", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ rates: { EUR: 0.012 } })),
    });
    const rate = await provider.fetch("INR", "EUR");
    expect(rate).toBeCloseTo(0.012);
  });

  it("returns null on HTTP 500", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: () => Promise.resolve(errorResponse(500)),
    });
    const rate = await provider.fetch("INR", "EUR");
    expect(rate).toBeNull();
  });

  it("returns null on network error (fetch throws)", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: () => Promise.reject(new Error("timeout")),
    });
    const rate = await provider.fetch("INR", "EUR");
    expect(rate).toBeNull();
  });

  it("returns null when body is missing the rate field", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: () =>
        Promise.resolve(okResponse({ rates: {} })), // No EUR key.
    });
    const rate = await provider.fetch("INR", "EUR");
    expect(rate).toBeNull();
  });

  it("handles XLM → FIAT via USD bridge (success)", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: (input) => {
        const url = String(input);
        if (url.includes("/live")) {
          // XLM/USD live rate: 1 XLM = 0.10 USD
          return Promise.resolve(okResponse({ quotes: { XLMUSD: 0.10 } }));
        }
        // INR/USD rate: 1 INR = 0.012 USD
        return Promise.resolve(okResponse({ rates: { USD: 0.012 } }));
      },
    });
    // XLM → INR = 0.10 / 0.012 ≈ 8.33
    const rate = await provider.fetch("XLM", "INR");
    expect(rate).toBeCloseTo(0.10 / 0.012, 2);
  });

  it("returns null when XLM/USD sub-fetch fails", async () => {
    const provider = new ExchangeRateProvider({
      fetchImpl: (input) => {
        const url = String(input);
        if (url.includes("/live")) return Promise.resolve(errorResponse(503)); // XLM/USD fails.
        return Promise.resolve(okResponse({ rates: { USD: 0.012 } }));
      },
    });
    const rate = await provider.fetch("INR", "XLM");
    expect(rate).toBeNull();
  });

  it("has provider name 'exchangerate-host'", () => {
    expect(new ExchangeRateProvider().name).toBe("exchangerate-host");
  });
});
