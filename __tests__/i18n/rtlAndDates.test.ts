import { isRTL, getDirection } from "@/lib/i18n/rtl";
import { formatLocaleDate, formatLocaleDateTime } from "@/lib/i18n/formatDate";
import { formatMoney, formatExact } from "@/lib/money/format";

describe("RTL Readiness & Locale Date/Money Formatting", () => {
  describe("RTL Support", () => {
    it("identifies RTL locales correctly", () => {
      expect(isRTL("ar-SA")).toBe(true);
      expect(isRTL("ar")).toBe(true);
      expect(isRTL("he")).toBe(true);
      expect(isRTL("fa")).toBe(true);
      expect(isRTL("ur")).toBe(true);
      expect(isRTL("en-US")).toBe(false);
      expect(isRTL("de-DE")).toBe(false);
      expect(isRTL("ja-JP")).toBe(false);
    });

    it("returns correct HTML direction attribute", () => {
      expect(getDirection("ar-SA")).toBe("rtl");
      expect(getDirection("en-US")).toBe("ltr");
      expect(getDirection("de-DE")).toBe("ltr");
    });
  });

  describe("Locale-Aware Date Formatting", () => {
    const testDate = new Date("2026-10-21T12:00:00.000Z");

    it("formats dates according to en-US conventions", () => {
      const formatted = formatLocaleDate(testDate, "en-US", "medium");
      expect(formatted).toMatch(/Oct 21, 2026/);
    });

    it("formats dates according to de-DE conventions", () => {
      const formatted = formatLocaleDate(testDate, "de-DE", "medium");
      // German format uses period after day, e.g. "21. Okt. 2026"
      expect(formatted).toContain("21.");
      expect(formatted).toContain("2026");
    });

    it("formats dates safely with pseudo-locale without throwing", () => {
      const formatted = formatLocaleDate(testDate, "qps-ploc", "medium");
      expect(formatted.startsWith("[!!! ")).toBe(true);
      expect(formatted.endsWith(" !!!]")).toBe(true);
    });

    it("formats date and time accurately", () => {
      const formatted = formatLocaleDateTime(testDate, "en-US");
      expect(formatted).toContain("2026");
      expect(formatted).toMatch(/\d{1,2}:\d{2}/);
    });
  });

  describe("Locale-Aware Money Formatting", () => {
    it("formats fiat currency in de-DE with European separators", () => {
      const res = formatMoney("1234.56", "EUR", "de-DE");
      // In German, 1.234,56 €
      expect(res.formatted).toContain("1.234");
      expect(res.formatted).toContain("56");
      expect(res.formatted).toContain("€");
    });

    it("formats crypto currency in ar-SA without errors", () => {
      const res = formatMoney("1234.56", "XLM", "ar-SA");
      expect(res.formatted).toContain("XLM");
    });

    it("formats exact precision values in Arabic", () => {
      const res = formatExact("1234.5678901", "XLM", "ar-SA");
      expect(res.formatted).toContain("XLM");
      expect(res.a11y).toContain("Stellar Lumens");
    });
  });
});
