import {
  normalizeCurrency,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
} from "@/lib/fx/currencies";
import { FxRateService } from "@/lib/fx/rateService";
import type { FxProvider } from "@/lib/fx/types";

describe("#226 currency whitelist", () => {
  it("rejects the cache-busting permutations from the issue", () => {
    for (const junk of ["AAAA", "BBBB", "ZZZZZ", "QQ", "ABCDEF"]) {
      expect(normalizeCurrency(junk)).toBeNull();
      expect(isSupportedCurrency(junk)).toBe(false);
    }
  });

  it("accepts the currencies the issue names", () => {
    for (const code of ["USD", "EUR", "GBP", "XLM", "USDC", "INR"]) {
      expect(isSupportedCurrency(code)).toBe(true);
    }
  });

  it("normalises case, whitespace and the USDC alias", () => {
    expect(normalizeCurrency("  inr ")).toBe("INR");
    expect(normalizeCurrency("usdc")).toBe("USD");
    expect(normalizeCurrency("USDT")).toBe("USD");
  });

  it("rejects non-string and malformed input", () => {
    for (const bad of [null, undefined, 42, {}, [], "", "US D", "US-D"]) {
      expect(normalizeCurrency(bad)).toBeNull();
    }
  });

  it("bounds the key space", () => {
    // Finite and small enough that the cache can realistically cover it.
    expect(SUPPORTED_CURRENCIES.length).toBeLessThan(100);
  });
});

describe("#226 rateService does not consult providers for junk pairs", () => {
  function spyProvider() {
    const calls: string[] = [];
    const provider: FxProvider = {
      name: "spy",
      async fetch(from: string, to: string) {
        calls.push(`${from}->${to}`);
        return 2;
      },
    };
    return { provider, calls };
  }

  it("never calls a provider for an unsupported pair", async () => {
    const { provider, calls } = spyProvider();
    const service = new FxRateService({ providers: [provider] });

    for (let i = 0; i < 50; i++) {
      const result = await service.getRate(`AA${i}`, `BB${i}`);
      expect(result.unavailable).toBe(true);
      expect(result.rate).toBeNull();
    }

    expect(calls).toHaveLength(0);
  });

  it("still serves a supported pair, and caches it", async () => {
    const { provider, calls } = spyProvider();
    const service = new FxRateService({ providers: [provider] });

    const first = await service.getRate("INR", "XLM");
    expect(first.rate).toBe(2);
    expect(first.unavailable).toBe(false);

    // Second identical request is a cache hit — no new upstream call.
    const second = await service.getRate("INR", "XLM");
    expect(second.rate).toBe(2);
    expect(calls).toHaveLength(1);
  });

  it("collapses USDC and USD onto one cache entry", async () => {
    const { provider, calls } = spyProvider();
    const service = new FxRateService({ providers: [provider] });

    await service.getRate("USD", "XLM");
    await service.getRate("USDC", "XLM");

    expect(calls).toEqual(["USD->XLM"]);
  });

  it("answers an identity pair without any provider call", async () => {
    const { provider, calls } = spyProvider();
    const service = new FxRateService({ providers: [provider] });

    const result = await service.getRate("USD", "USDC");
    expect(result.rate).toBe(1);
    expect(result.unavailable).toBe(false);
    expect(calls).toHaveLength(0);
  });
});
