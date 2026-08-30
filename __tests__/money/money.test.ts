import {
  getAssetConfig,
  formatMoney,
  formatExact,
  adjustAmountsForDisplay,
} from "../../lib/money/format";

describe("Money Formatting Engine (S2 Seam)", () => {
  describe("getAssetConfig", () => {
    it("should resolve known assets correctly", () => {
      expect(getAssetConfig("XLM")).toEqual({
        decimals: 4,
        isFiat: false,
        name: "Stellar Lumens",
      });
      expect(getAssetConfig("USDC")).toEqual({
        decimals: 2,
        isFiat: false,
        name: "USDC",
      });
      expect(getAssetConfig("JPY")).toEqual({
        decimals: 0,
        isFiat: true,
        name: "Japanese Yen",
      });
      expect(getAssetConfig("USD")).toEqual({
        decimals: 2,
        isFiat: true,
        name: "US Dollars",
      });
    });

    it("should fallback for unknown tokens", () => {
      expect(getAssetConfig("CUSTOM")).toEqual({
        decimals: 4,
        isFiat: false,
        name: "CUSTOM",
      });
    });
  });

  describe("formatMoney", () => {
    it("should format fiat correctly in different locales", () => {
      // JPY is zero-decimal
      const jpyJa = formatMoney(1000, "JPY", "ja-JP").formatted;
      expect(jpyJa.replace(/\s/g, "")).toMatch(/[¥￥]1,000/);

      // USD standard formatting
      const usdEn = formatMoney(1234.56, "USD", "en-US").formatted;
      expect(usdEn.replace(/\s/g, "")).toBe("$1,234.56");

      // EUR standard formatting with comma separator
      const eurDe = formatMoney(1234.56, "EUR", "de-DE").formatted;
      expect(eurDe.replace(/\u00a0/g, " ").trim()).toBe("1.234,56 €");

      // INR with Indian numbering system (e.g. 1,23,456.78)
      const inrHi = formatMoney(123456.78, "INR", "hi-IN").formatted;
      expect(inrHi.replace(/\u00a0/g, " ").replace(/\s/g, "")).toContain("₹1,23,456.78");
    });

    it("should format XLM and custom tokens correctly with locale-correct placement", () => {
      const xlmEn = formatMoney(12.3456, "XLM", "en-US").formatted;
      expect(xlmEn.replace(/\u00a0/g, " ").trim()).toBe("XLM 12.3456");

      const xlmDe = formatMoney(12.3456, "XLM", "de-DE").formatted;
      expect(xlmDe.replace(/\u00a0/g, " ").trim()).toBe("12,3456 XLM");
    });
  });

  describe("formatExact", () => {
    it("should format exact values without floating-point precision loss", () => {
      const exactVal = "1234567.890123456";
      const exactEn = formatExact(exactVal, "XLM", "en-US").formatted;
      expect(exactEn.replace(/\u00a0/g, " ").trim()).toBe("XLM 1,234,567.890123456");

      const exactDe = formatExact(exactVal, "XLM", "de-DE").formatted;
      expect(exactDe.replace(/\u00a0/g, " ").trim()).toBe("1.234.567,890123456 XLM");
    });
  });

  describe("adjustAmountsForDisplay (Largest Remainder Method)", () => {
    it("should distribute roundoff error to ensure sum-consistency", () => {
      // 100 divided by 3 is 33.3333333...
      // For XLM (4 decimals), standard rounding makes them all 33.3333
      // 33.3333 * 3 = 99.9999 (short of 100.0000 by 0.0001)
      // The largest remainder method should bump one share to 33.3334
      const shares = ["33.3333333", "33.3333333", "33.3333333"];
      const adjusted = adjustAmountsForDisplay(shares, "100.0000", "XLM");

      expect(adjusted).toHaveLength(3);
      const sum = adjusted.reduce((acc, val) => acc + parseFloat(val), 0);
      expect(sum).toBeCloseTo(100.0000, 5);
      expect(adjusted).toContain("33.3334");
      expect(adjusted.filter(x => x === "33.3333")).toHaveLength(2);
    });

    it("should handle rounding down correction", () => {
      // 100.01 divided by 3 is 33.336666...
      // Bumping factor: 4 decimals.
      // 33.3367 * 3 = 100.0101 (over by 0.0001)
      // Should deduct 0.0001 from one share
      const shares = ["33.3366666", "33.3366666", "33.3366666"];
      const adjusted = adjustAmountsForDisplay(shares, "100.0100", "XLM");

      expect(adjusted).toHaveLength(3);
      const sum = adjusted.reduce((acc, val) => acc + parseFloat(val), 0);
      expect(sum).toBeCloseTo(100.0100, 5);
      expect(adjusted).toContain("33.3366");
      expect(adjusted.filter(x => x === "33.3367")).toHaveLength(2);
    });
  });
});
