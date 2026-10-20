import { type Locale } from "./types";

const RTL_LOCALES = new Set<string>([
  "ar",
  "ar-SA",
  "ar-EG",
  "ar-AE",
  "he",
  "he-IL",
  "fa",
  "fa-IR",
  "ur",
  "ur-PK",
]);

/**
 * Checks if a given locale code requires right-to-left (RTL) text layout.
 */
export function isRTL(locale: string): boolean {
  if (!locale) return false;
  const normalized = locale.trim().toLowerCase();
  const base = normalized.split("-")[0];
  return RTL_LOCALES.has(locale) || RTL_LOCALES.has(normalized) || RTL_LOCALES.has(base);
}

/**
 * Returns the HTML direction attribute string ("rtl" or "ltr").
 */
export function getDirection(locale: string): "rtl" | "ltr" {
  return isRTL(locale) ? "rtl" : "ltr";
}
