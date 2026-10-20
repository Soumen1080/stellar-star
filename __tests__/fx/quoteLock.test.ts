/**
 * #323 — locked FX quotes: rounding, stale and expired quotes, provider
 * disagreement, and no conversion for native-asset input.
 */

import fs from "node:fs";
import path from "node:path";
import {
  PROVIDER_DISAGREEMENT_BPS,
  QUOTE_LOCK_TTL_MS,
  buildProvenance,
  canConvertWith,
  canSubmitWith,
  describeSavedConversion,
  enteredAmountOf,
  providerSpreadBps,
  quoteState,
  settlementAmountFor,
  type LockedQuote,
} from "@/lib/fx/quoteLock";
import { FxRateService } from "@/lib/fx/rateService";
import type { FxProvider } from "@/lib/fx/types";

const NOW = Date.parse("2026-10-20T08:00:00.000Z");

function quote(overrides: Partial<LockedQuote> = {}): LockedQuote {
  return {
    from: "EUR",
    to: "XLM",
    rate: "3.2493827",
    source: "coingecko",
    fetchedAt: new Date(NOW).toISOString(),
    lockedAt: new Date(NOW).toISOString(),
    stale: false,
    ...overrides,
  };
}

const stateOf = (q: LockedQuote | null, currency = "EUR", extra: Partial<Parameters<typeof quoteState>[0]> = {}) =>
  quoteState({ currency, quote: q, loading: false, failed: q === null, now: NOW, ...extra });

describe("quote states", () => {
  it("is fresh right after locking, and only fresh converts", () => {
    expect(stateOf(quote())).toBe("fresh");
    expect(canConvertWith("fresh")).toBe(true);
    for (const s of ["stale", "expired", "disagreement", "unavailable", "loading"] as const) {
      expect({ s, converts: canConvertWith(s), submits: canSubmitWith(s) }).toEqual({ s, converts: false, submits: false });
    }
  });

  it("marks a service-stale (cached past TTL) quote as degraded", () => {
    expect(stateOf(quote({ stale: true }))).toBe("stale");
  });

  it("expires a locked quote after the lock TTL", () => {
    const lockedAt = new Date(NOW - QUOTE_LOCK_TTL_MS - 1).toISOString();
    expect(stateOf(quote({ lockedAt }))).toBe("expired");
    expect(stateOf(quote({ lockedAt: new Date(NOW - QUOTE_LOCK_TTL_MS + 1000).toISOString() }))).toBe("fresh");
  });

  it("treats an unparsable lock time as expired, never as fresh", () => {
    expect(stateOf(quote({ lockedAt: "garbage" }))).toBe("expired");
  });

  it("does not use a quote locked for a different currency", () => {
    expect(stateOf(quote({ from: "USD" }), "EUR", { failed: true })).toBe("unavailable");
  });

  it("reports unavailable when the fetch failed", () => {
    expect(stateOf(null)).toBe("unavailable");
  });
});

describe("no conversion for native-asset input", () => {
  it("needs no quote and only normalises to ledger precision", () => {
    expect(stateOf(null, "XLM")).toBe("native");
    expect(canSubmitWith("native")).toBe(true);
    expect(settlementAmountFor("12.5", "XLM", null, "native")).toBe("12.5000000");
  });

  it("ignores any quote that happens to be present", () => {
    expect(settlementAmountFor("10", "XLM", quote({ rate: "999" }), "native")).toBe("10.0000000");
  });

  it("records no exchange rate in the provenance", () => {
    expect(buildProvenance("10", "XLM", null, "native")).toEqual({
      enteredCurrency: "XLM",
      enteredAmount: "10",
      settlementAsset: "native",
      settlementAmount: "10.0000000",
    });
  });
});

describe("rounding", () => {
  it("converts exactly and rounds half-even at 7 decimals", () => {
    // 25 × 3.2493827 = 81.2345675 exactly.
    expect(settlementAmountFor("25", "EUR", quote(), "fresh")).toBe("81.2345675");
    // 0.01 × 0.00000005 = 0.0000000005: below half a stroop, rounds to 0.
    expect(settlementAmountFor("0.01", "EUR", quote({ rate: "0.00000005" }), "fresh")).toBe("0.0000000");
    // 1 × 0.00000015 = 1.5 stroops: an exact tie, rounds half-even up to 2.
    expect(settlementAmountFor("1", "EUR", quote({ rate: "0.00000015" }), "fresh")).toBe("0.0000002");
    // 1 × 0.00000025 = 2.5 stroops: an exact tie, rounds half-even down to 2.
    expect(settlementAmountFor("1", "EUR", quote({ rate: "0.00000025" }), "fresh")).toBe("0.0000002");
  });

  it("never emits float or exponent notation, even for large or tiny values", () => {
    const big = settlementAmountFor("123456789.99", "USD", quote({ from: "USD", rate: "12.3456789" }), "fresh")!;
    expect(big).toBe("1524157887.2412742");
    expect(big).not.toMatch(/e/i);
  });

  it("refuses to convert through a non-fresh quote", () => {
    expect(settlementAmountFor("25", "EUR", quote(), "stale")).toBeNull();
    expect(settlementAmountFor("25", "EUR", quote(), "expired")).toBeNull();
    expect(buildProvenance("25", "EUR", quote(), "disagreement")).toBeNull();
  });

  it("returns null for amounts that do not parse", () => {
    expect(settlementAmountFor("abc", "EUR", quote(), "fresh")).toBeNull();
    expect(settlementAmountFor("", "EUR", quote(), "fresh")).toBeNull();
  });

  it("reconstructs the entered amount exactly for rows saved before #323", () => {
    expect(enteredAmountOf({ currency: "EUR", totalAmount: "81.2345675", exchangeRate: "3.2493827" })).toBe("25.00");
    // 1 / 3 at 2 decimals, half-even: 0.33 — computed without floats.
    expect(enteredAmountOf({ currency: "USD", totalAmount: "1", exchangeRate: "3" })).toBe("0.33");
    expect(enteredAmountOf({ currency: "JPY", totalAmount: "10", exchangeRate: "0.0666666" })).toBe("150");
    expect(enteredAmountOf({ currency: "XLM", totalAmount: "10" })).toBeNull();
    expect(enteredAmountOf({ currency: "EUR", totalAmount: "1", enteredAmount: "0.31", exchangeRate: "3" })).toBe("0.31");
  });
});

describe("provider disagreement", () => {
  it("computes the spread exactly in basis points of the lower rate", () => {
    expect(providerSpreadBps([{ source: "a", rate: "100" }, { source: "b", rate: "102" }])).toBe(200);
    expect(providerSpreadBps([{ source: "a", rate: "100" }, { source: "b", rate: "100.0001" }])).toBe(1);
    expect(providerSpreadBps([{ source: "a", rate: "3.2493827" }])).toBeUndefined();
  });

  it("blocks conversion above the threshold and allows it at the threshold", () => {
    expect(stateOf(quote({ spreadBps: PROVIDER_DISAGREEMENT_BPS }))).toBe("fresh");
    expect(stateOf(quote({ spreadBps: PROVIDER_DISAGREEMENT_BPS + 1 }))).toBe("disagreement");
  });

  function provider(name: string, rate: number | null): FxProvider {
    return { name, fetch: async () => rate };
  }

  it("the service flags disagreeing providers but keeps the primary rate", async () => {
    const service = new FxRateService({
      providers: [provider("coingecko", 3.25), provider("exchangerate", 3.4)],
      now: () => NOW,
    });
    const result = await service.getCorroboratedRate("EUR", "XLM");
    expect(result.source).toBe("coingecko");
    expect(result.rateDecimal).toBe("3.25");
    expect(result.disagreement).toBe(true);
    expect(result.spreadBps).toBe(462);
    expect(result.providers).toEqual([
      { source: "coingecko", rate: "3.25" },
      { source: "exchangerate", rate: "3.4" },
    ]);
  });

  it("the service reports agreement when providers are close", async () => {
    const service = new FxRateService({
      providers: [provider("coingecko", 3.25), provider("exchangerate", 3.251)],
      now: () => NOW,
    });
    const result = await service.getCorroboratedRate("EUR", "XLM");
    expect(result.disagreement).toBe(false);
    expect(result.spreadBps).toBe(4);
  });

  it("falls back to the cache, flagged, when no provider answers", async () => {
    let live = true;
    let clock = NOW;
    const service = new FxRateService({
      providers: [{ name: "only", fetch: async () => (live ? 3.25 : null) }],
      now: () => clock,
    });
    await service.getCorroboratedRate("EUR", "XLM");
    live = false;
    clock += 2 * 60 * 60 * 1000; // past the crypto max-stale window: the entry is evicted
    const result = await service.getCorroboratedRate("EUR", "XLM");
    expect(result.unavailable).toBe(true);
    expect(result.rate).toBeNull();
  });
});

describe("saved provenance is visible and immutable", () => {
  it("describes the saved conversion for the expense history", () => {
    expect(
      describeSavedConversion({
        currency: "EUR",
        totalAmount: "81.2345675",
        enteredAmount: "25.00",
        exchangeRate: "3.2493827",
        exchangeRateSource: "coingecko",
        exchangeRateTimestamp: "2026-10-20T08:00:00.000Z",
      }),
    ).toBe("25.00 EUR → 81.2345675 XLM at 3.2493827 XLM/EUR, quoted by coingecko at 2026-10-20 08:00 UTC.");
    expect(describeSavedConversion({ currency: "XLM", totalAmount: "5.0000000" })).toMatch(/no conversion/);
  });

  it("freezes every provenance column in both provisioning paths", () => {
    const ROOT = path.resolve(__dirname, "../..");
    for (const file of ["migrations/0010_fx_quote_provenance.sql", "supabase-setup.sql"]) {
      const sql = fs.readFileSync(path.join(ROOT, file), "utf8");
      for (const column of ["exchange_rate", "exchange_rate_timestamp", "exchange_rate_source", "entered_amount", "settlement_asset"]) {
        expect({ file, column, frozen: sql.includes(`jsonb_build_object('${column}', old_json -> '${column}')`) })
          .toEqual({ file, column, frozen: true });
      }
    }
  });
});
