/**
 * Path payment tests against recorded Horizon fixture shapes.
 *
 * The cases that matter are the money-losing ones: sendMax derived from a
 * quote, a thin book with severe price impact, and a stale quote.
 */

import {
  deriveSendMax,
  findPaymentPaths,
  fromStroops,
  isQuoteFresh,
  PathPaymentError,
  priceQuote,
  quoteAgeRemainingMs,
  toStroops,
  DEFAULT_SLIPPAGE_BPS,
  HIGH_PRICE_IMPACT_BPS,
  QUOTE_FRESHNESS_MS,
} from "@/lib/stellar/pathPayment";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET } from "@/lib/stellar/assets";

const USDC = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

/** A healthy book: three routes, tightly clustered prices. */
const DEEP_BOOK_FIXTURE = {
  _embedded: {
    records: [
      {
        source_asset_type: "native",
        source_amount: "102.5000000",
        destination_asset_type: "credit_alphanum4",
        destination_asset_code: "USDC",
        destination_asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
        destination_amount: "10.0000000",
        path: [],
      },
      {
        source_asset_type: "native",
        source_amount: "103.1000000",
        destination_asset_type: "credit_alphanum4",
        destination_asset_code: "USDC",
        destination_asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
        destination_amount: "10.0000000",
        path: [
          { asset_type: "credit_alphanum4", asset_code: "EURT", asset_issuer: "GEURT" },
        ],
      },
    ],
  },
};

/**
 * A thin book: the only alternative route is 40% worse, because it goes
 * through an illiquid intermediate. This is the case a quote does not surface
 * on its own and where a generous sendMax would quietly overpay.
 */
const THIN_BOOK_FIXTURE = {
  _embedded: {
    records: [
      {
        source_asset_type: "native",
        source_amount: "100.0000000",
        destination_asset_type: "credit_alphanum4",
        destination_asset_code: "USDC",
        destination_asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
        destination_amount: "10.0000000",
        path: [],
      },
      {
        source_asset_type: "native",
        source_amount: "140.0000000",
        destination_asset_type: "credit_alphanum4",
        destination_asset_code: "USDC",
        destination_asset_issuer: CIRCLE_USDC_ISSUER_TESTNET,
        destination_amount: "10.0000000",
        path: [
          { asset_type: "credit_alphanum12", asset_code: "ILLIQUID", asset_issuer: "GILL" },
        ],
      },
    ],
  },
};

const EMPTY_FIXTURE = { _embedded: { records: [] } };

function fixtureFetch(body: unknown, status = 200) {
  return jest.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })) as unknown as typeof fetch;
}

const baseParams = {
  sourceAccount: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
  destinationAsset: USDC,
  destinationAmount: "10.0000000",
};

describe("amount conversion", () => {
  it("round-trips through stroops without float error", () => {
    // The reason this is BigInt: 0.1 + 0.2 must be exactly 0.3.
    expect(toStroops("0.1") + toStroops("0.2")).toBe(toStroops("0.3"));
    expect(fromStroops(toStroops("102.5000000"))).toBe("102.5000000");
  });

  it("rejects more than 7 decimals", () => {
    expect(() => toStroops("1.00000001")).toThrow();
  });
});

describe("deriveSendMax", () => {
  it("adds the tolerance to the quoted source amount", () => {
    expect(deriveSendMax("100.0000000", 100)).toBe("101.0000000");
    expect(deriveSendMax("100.0000000", 50)).toBe("100.5000000");
  });

  it("rounds up, never down", () => {
    // Rounding down would build a limit fractionally below the tolerance the
    // user agreed to, failing payments at the boundary.
    const result = deriveSendMax("0.0000001", 1);
    expect(toStroops(result)).toBeGreaterThanOrEqual(toStroops("0.0000001"));
  });

  it("is the identity at zero slippage", () => {
    expect(deriveSendMax("42.1234567", 0)).toBe("42.1234567");
  });

  it("refuses a tolerance above the cap", () => {
    // An unbounded tolerance is an unbounded spend — invariant 2.
    expect(() => deriveSendMax("100.0000000", 5_000)).toThrow();
  });

  it("refuses a negative tolerance", () => {
    expect(() => deriveSendMax("100.0000000", -100)).toThrow();
  });
});

describe("path discovery", () => {
  it("returns quotes cheapest-first", async () => {
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(DEEP_BOOK_FIXTURE),
    });

    expect(quotes).toHaveLength(2);
    expect(quotes[0].sourceAmount).toBe("102.5000000");
  });

  it("preserves the exact destination amount on every route", async () => {
    // Invariant 1: strict-receive fixes what the recipient gets.
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(DEEP_BOOK_FIXTURE),
    });

    for (const quote of quotes) {
      expect(quote.destinationAmount).toBe("10.0000000");
    }
  });

  it("parses the intermediate path assets", async () => {
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(DEEP_BOOK_FIXTURE),
    });

    expect(quotes[0].path).toEqual([]);
    expect(quotes[1].path).toEqual([{ code: "EURT", issuer: "GEURT" }]);
  });

  it("reports no_path rather than a generic failure when the book is empty", async () => {
    // Invariant 5: actionable, not a shrug.
    await expect(
      findPaymentPaths({ ...baseParams, fetchImpl: fixtureFetch(EMPTY_FIXTURE) }),
    ).rejects.toMatchObject({ reason: "no_path" });
  });

  it("reports unavailable when Horizon errors", async () => {
    // Distinct from no_path: retrying may help, so the UI must not tell the
    // user no route exists.
    await expect(
      findPaymentPaths({ ...baseParams, fetchImpl: fixtureFetch({}, 503) }),
    ).rejects.toMatchObject({ reason: "unavailable" });
  });

  it("reports unavailable when the network throws", async () => {
    const failing = jest.fn(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;

    await expect(
      findPaymentPaths({ ...baseParams, fetchImpl: failing }),
    ).rejects.toBeInstanceOf(PathPaymentError);
  });
});

describe("price impact", () => {
  it("is zero for the best route", async () => {
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(THIN_BOOK_FIXTURE),
    });

    expect(quotes[0].priceImpactBps).toBe(0);
  });

  it("surfaces severe impact on a thin book", async () => {
    // 140 vs 100 is 4000bps — the kind of route a raw quote does not warn
    // about and a generous sendMax would silently accept.
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(THIN_BOOK_FIXTURE),
    });

    expect(quotes[1].priceImpactBps).toBe(4_000);
    expect(priceQuote(quotes[1], DEFAULT_SLIPPAGE_BPS).highPriceImpact).toBe(true);
  });

  it("does not flag a route inside the impact threshold", async () => {
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(DEEP_BOOK_FIXTURE),
    });

    expect(quotes[1].priceImpactBps).toBeLessThan(HIGH_PRICE_IMPACT_BPS);
    expect(priceQuote(quotes[1], DEFAULT_SLIPPAGE_BPS).highPriceImpact).toBe(false);
  });
});

describe("quote freshness", () => {
  it("is fresh inside the window and stale outside it", () => {
    const quote = {
      sourceAsset: NATIVE_ASSET,
      sourceAmount: "100.0000000",
      destinationAsset: USDC,
      destinationAmount: "10.0000000",
      path: [],
      quotedAt: 1_000_000,
      priceImpactBps: 0,
    };

    expect(isQuoteFresh(quote, 1_000_000)).toBe(true);
    expect(isQuoteFresh(quote, 1_000_000 + QUOTE_FRESHNESS_MS - 1)).toBe(true);
    // At the boundary the quote is no longer signable: a maximum derived from
    // a book this old is not a confirmed maximum.
    expect(isQuoteFresh(quote, 1_000_000 + QUOTE_FRESHNESS_MS)).toBe(false);
  });

  it("reports remaining validity, floored at zero", () => {
    const quote = {
      sourceAsset: NATIVE_ASSET,
      sourceAmount: "100.0000000",
      destinationAsset: USDC,
      destinationAmount: "10.0000000",
      path: [],
      quotedAt: 1_000_000,
      priceImpactBps: 0,
    };

    expect(quoteAgeRemainingMs(quote, 1_000_000)).toBe(QUOTE_FRESHNESS_MS);
    expect(quoteAgeRemainingMs(quote, 9_999_999)).toBe(0);
  });
});

describe("pricing a quote", () => {
  it("carries the sendMax the user will be shown", async () => {
    const quotes = await findPaymentPaths({
      ...baseParams,
      fetchImpl: fixtureFetch(THIN_BOOK_FIXTURE),
    });
    const priced = priceQuote(quotes[0], 100);

    expect(priced.sendMax).toBe("101.0000000");
    expect(priced.slippageBps).toBe(100);
    // The received amount is untouched by slippage — only the spend floats.
    expect(priced.destinationAmount).toBe("10.0000000");
  });
});
