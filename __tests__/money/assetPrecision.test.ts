import {
  convertAssetAmount,
  getAssetPrecision,
  normalizeDecimalRate,
  toLedgerAmount,
} from "@/lib/money/assetPrecision";
import { prepareSettlementAmount } from "@/lib/settlement/settle";

describe("asset precision boundaries", () => {
  it("separates display precision from Stellar ledger precision", () => {
    expect(getAssetPrecision("native")).toMatchObject({
      code: "XLM",
      kind: "stellar",
      displayDecimals: 4,
      ledgerDecimals: 7,
    });
    expect(getAssetPrecision("USDC:GISSUER")).toMatchObject({
      code: "USDC",
      kind: "stellar",
      displayDecimals: 2,
      ledgerDecimals: 7,
    });
    expect(getAssetPrecision("USD")).toMatchObject({
      kind: "fiat",
      displayDecimals: 2,
      ledgerDecimals: null,
    });
    // A Stellar token may use the same code as a fiat currency.
    expect(getAssetPrecision("USD:GISSUER").kind).toBe("stellar");
  });

  it("converts FX amounts with integer arithmetic and one explicit rounding", () => {
    expect(convertAssetAmount("10.01", "USD", "XLM", "0.123456789")).toBe(
      "1.2358025",
    );
    expect(convertAssetAmount("0.29", "USD", "XLM", "0.3333333")).toBe(
      "0.0966667",
    );
  });

  it("normalizes every Stellar settlement asset to contract precision", () => {
    expect(toLedgerAmount("1.005", "USDC:GISSUER")).toBe("1.0050000");
    expect(prepareSettlementAmount("2.5", "native")).toBe("2.5000000");
    expect(() => prepareSettlementAmount("1", "USD")).toThrow(/display currency/i);
    expect(() => prepareSettlementAmount("0", "native")).toThrow(/greater than zero/i);
  });

  it("preserves provider decimals, including exponent notation", () => {
    expect(normalizeDecimalRate(1.42e-7)).toBe("0.000000142");
    expect(normalizeDecimalRate("0.1234000")).toBe("0.1234");
    expect(normalizeDecimalRate("0")).toBeNull();
  });
});
