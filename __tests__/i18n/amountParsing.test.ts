import { parseLocaleAmount } from "@/lib/i18n/parseAmount";

describe("Locale-Aware Amount Parsing & Ambiguity Prevention", () => {
  describe("Standard inputs and locale conventions", () => {
    it("parses plain integers and standard decimals in en-US", () => {
      expect(parseLocaleAmount("100", "en-US")).toEqual({
        success: true,
        canonicalAmount: "100",
        value: 100,
      });

      expect(parseLocaleAmount("1234.56", "en-US")).toEqual({
        success: true,
        canonicalAmount: "1234.56",
        value: 1234.56,
      });

      expect(parseLocaleAmount("1,234.56", "en-US")).toEqual({
        success: true,
        canonicalAmount: "1234.56",
        value: 1234.56,
      });

      expect(parseLocaleAmount("1,234,567.89", "en-US")).toEqual({
        success: true,
        canonicalAmount: "1234567.89",
        value: 1234567.89,
      });
    });

    it("parses German/European comma decimal inputs in de-DE", () => {
      expect(parseLocaleAmount("12,50", "de-DE")).toEqual({
        success: true,
        canonicalAmount: "12.50",
        value: 12.5,
      });

      expect(parseLocaleAmount("1.234,56", "de-DE")).toEqual({
        success: true,
        canonicalAmount: "1234.56",
        value: 1234.56,
      });

      expect(parseLocaleAmount("1.234.567,89", "de-DE")).toEqual({
        success: true,
        canonicalAmount: "1234567.89",
        value: 1234567.89,
      });

      expect(parseLocaleAmount("1.234", "de-DE")).toEqual({
        success: true,
        canonicalAmount: "1234",
        value: 1234,
      });
    });

    it("parses Indian numbering conventions in hi-IN", () => {
      expect(parseLocaleAmount("1,23,456.78", "hi-IN")).toEqual({
        success: true,
        canonicalAmount: "123456.78",
        value: 123456.78,
      });
    });

    it("parses Arabic-Indic digits and Arabic decimal separator in ar-SA", () => {
      // "١٢٣٤٫٥٦" = 1234.56 with Arabic decimal separator (٫)
      const parsed = parseLocaleAmount("١٢٣٤٫٥٦", "ar-SA");
      expect(parsed.success).toBe(true);
      expect(parsed.canonicalAmount).toBe("1234.56");
      expect(parsed.value).toBe(1234.56);
    });

    it("handles whitespace and thin space grouping separators", () => {
      expect(parseLocaleAmount("1 234.56", "en-US")).toEqual({
        success: true,
        canonicalAmount: "1234.56",
        value: 1234.56,
      });

      expect(parseLocaleAmount("1 234,56", "de-DE")).toEqual({
        success: true,
        canonicalAmount: "1234.56",
        value: 1234.56,
      });
    });
  });

  describe("Ambiguous amount prevention", () => {
    it("rejects multiple decimal points or commas", () => {
      const res1 = parseLocaleAmount("1.2.3", "en-US");
      expect(res1.success).toBe(false);
      expect(res1.error).toMatch(/ambiguous|multiple/i);

      const res2 = parseLocaleAmount("1,2,3", "en-US");
      expect(res2.success).toBe(false);
      expect(res2.error).toMatch(/ambiguous|multiple/i);
    });

    it("rejects ambiguous comma with non-three digit grouping in en-US", () => {
      // In en-US, "," followed by 2 digits is ambiguous (European decimal or typo)
      const res = parseLocaleAmount("12,50", "en-US");
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/ambiguous/i);
    });

    it("rejects consecutive separators", () => {
      const res1 = parseLocaleAmount("12..50", "en-US");
      expect(res1.success).toBe(false);

      const res2 = parseLocaleAmount("12,,50", "de-DE");
      expect(res2.success).toBe(false);
    });

    it("rejects illegal characters like currency symbols and letters", () => {
      expect(parseLocaleAmount("$100", "en-US").success).toBe(false);
      expect(parseLocaleAmount("100 EUR", "de-DE").success).toBe(false);
      expect(parseLocaleAmount("abc", "en-US").success).toBe(false);
    });

    it("rejects empty or whitespace-only inputs", () => {
      expect(parseLocaleAmount("", "en-US").success).toBe(false);
      expect(parseLocaleAmount("   ", "en-US").success).toBe(false);
    });

    it("maintains strict canonical string output for storage and on-chain calculations", () => {
      // Stored canonical representation must ALWAYS be standard ASCII with period decimal
      const deResult = parseLocaleAmount("9999,99", "de-DE");
      expect(deResult.canonicalAmount).toBe("9999.99");
      expect(deResult.canonicalAmount).not.toContain(",");

      const arResult = parseLocaleAmount("٩٩٩٩٫٩٩", "ar-SA");
      expect(arResult.canonicalAmount).toBe("9999.99");
      expect(arResult.canonicalAmount).not.toContain("٫");
    });
  });
});
