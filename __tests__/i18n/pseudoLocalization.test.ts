import { pseudoLocalize, isPseudoLocale } from "@/lib/i18n/pseudo";
import { translate } from "@/lib/i18n/translations";

describe("Pseudo-Localization System (qps-ploc)", () => {
  it("identifies pseudo-locale codes correctly", () => {
    expect(isPseudoLocale("qps-ploc")).toBe(true);
    expect(isPseudoLocale("en-XA")).toBe(true);
    expect(isPseudoLocale("pseudo")).toBe(true);
    expect(isPseudoLocale("en-US")).toBe(false);
    expect(isPseudoLocale("de-DE")).toBe(false);
  });

  it("accents ASCII characters and wraps with markers", () => {
    const output = pseudoLocalize("Save");
    expect(output.startsWith("[!!! ")).toBe(true);
    expect(output.endsWith(" !!!]")).toBe(true);
    // Contains accented characters (e.g. S -> Š, a -> à, v -> ṽ, e -> é)
    expect(output).toContain("Š");
    expect(output).toContain("à");
  });

  it("expands text length to test UI overflow resilience", () => {
    const input = "Confirm Settlement Intent";
    const output = pseudoLocalize(input);
    // Accented and expanded output must be longer than original input
    expect(output.length).toBeGreaterThan(input.length * 1.2);
  });

  it("strictly preserves interpolation tokens unchanged", () => {
    const input = "Pay {amount} XLM to {recipient}";
    const output = pseudoLocalize(input);

    expect(output).toContain("{amount}");
    expect(output).toContain("{recipient}");
    expect(output).not.toContain("{àɱöûñţ}");
  });

  it("strictly preserves HTML tags unchanged", () => {
    const input = "Click <b>here</b> for details";
    const output = pseudoLocalize(input);

    expect(output).toContain("<b>");
    expect(output).toContain("</b>");
  });

  it("translates into pseudo-locale and substitutes variables cleanly", () => {
    const result = translate("qps-ploc", "nav.features");
    expect(result.startsWith("[!!! ")).toBe(true);
    expect(result.endsWith(" !!!]")).toBe(true);
    expect(result).toContain("Ƒ"); // F -> Ƒ
  });
});
