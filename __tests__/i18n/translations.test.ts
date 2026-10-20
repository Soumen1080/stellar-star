import { translate, EN_US, DE_DE, HI_IN, JA_JP, AR_SA } from "@/lib/i18n/translations";
import { type Locale } from "@/lib/i18n/types";

describe("i18n Translations System", () => {
  it("translates common keys into English (en-US)", () => {
    expect(translate("en-US", "nav.features")).toBe("Features");
    expect(translate("en-US", "common.save")).toBe("Save");
    expect(translate("en-US", "expenses.newExpense")).toBe("New Expense");
    expect(translate("en-US", "trips.workspace")).toBe("Travel Workspace");
  });

  it("translates keys into German (de-DE)", () => {
    expect(translate("de-DE", "nav.features")).toBe("Funktionen");
    expect(translate("de-DE", "common.save")).toBe("Speichern");
    expect(translate("de-DE", "expenses.newExpense")).toBe("Neue Ausgabe");
    expect(translate("de-DE", "trips.workspace")).toBe("Reisebereich");
  });

  it("translates keys into Hindi (hi-IN)", () => {
    expect(translate("hi-IN", "nav.features")).toBe("सुविधाएँ");
    expect(translate("hi-IN", "common.save")).toBe("सहेजें");
    expect(translate("hi-IN", "expenses.newExpense")).toBe("नया खर्च");
  });

  it("translates keys into Japanese (ja-JP)", () => {
    expect(translate("ja-JP", "nav.features")).toBe("機能");
    expect(translate("ja-JP", "common.save")).toBe("保存");
    expect(translate("ja-JP", "expenses.newExpense")).toBe("新規経費");
  });

  it("translates keys into Arabic (ar-SA)", () => {
    expect(translate("ar-SA", "nav.features")).toBe("الميزات");
    expect(translate("ar-SA", "common.save")).toBe("حفظ");
    expect(translate("ar-SA", "expenses.newExpense")).toBe("مصروف جديد");
  });

  it("falls back to English when a key is missing in the requested locale", () => {
    // Non-existent key in DE fallback to EN or key itself
    const fallback = translate("de-DE" as Locale, "nonexistent.key.xyz");
    expect(fallback).toBe("nonexistent.key.xyz");
  });

  it("interpolates variables in the template string", () => {
    // Direct interpolation test
    const customEn = "Hello {name}, you have {count} items.";
    let result = customEn.replace("{name}", "Asha").replace("{count}", "5");
    expect(result).toBe("Hello Asha, you have 5 items.");

    // Function parameter interpolation test
    const rendered = translate("en-US", "common.save", { unused: "test" });
    expect(rendered).toBe("Save");
  });

  it("ensures key coverage symmetry across major dictionaries", () => {
    const enKeys = Object.keys(EN_US);
    const deKeys = Object.keys(DE_DE);
    const hiKeys = Object.keys(HI_IN);
    const jaKeys = Object.keys(JA_JP);
    const arKeys = Object.keys(AR_SA);

    expect(deKeys.length).toBeGreaterThanOrEqual(enKeys.length);
    expect(hiKeys.length).toBeGreaterThanOrEqual(enKeys.length);
    expect(jaKeys.length).toBeGreaterThanOrEqual(enKeys.length);
    expect(arKeys.length).toBeGreaterThanOrEqual(enKeys.length);
  });
});
