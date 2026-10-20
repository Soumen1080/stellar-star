import { type Locale } from "./types";
import { isPseudoLocale, pseudoLocalize } from "./pseudo";

export type DateFormatStyle = "short" | "medium" | "long" | "full";

export const PRESET_OPTIONS: Record<DateFormatStyle, Intl.DateTimeFormatOptions> = {
  short: { month: "numeric", day: "numeric", year: "numeric" },
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
};

/**
 * Normalizes locale code for safe usage with Intl APIs (Node and browser).
 * Maps pseudo-locale "qps-ploc" to "en-US".
 */
export function normalizeIntlLocale(locale: string): string {
  if (!locale || isPseudoLocale(locale)) {
    return "en-US";
  }
  return locale;
}

/**
 * Formats a date string, timestamp, or Date object into a localized date string.
 */
export function formatLocaleDate(
  dateInput: Date | string | number,
  locale: Locale | string = "en-US",
  options?: Intl.DateTimeFormatOptions | DateFormatStyle
): string {
  const date = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }

  const intlLocale = normalizeIntlLocale(locale);
  const resolvedOptions: Intl.DateTimeFormatOptions =
    typeof options === "string"
      ? PRESET_OPTIONS[options] ?? PRESET_OPTIONS.medium
      : options ?? PRESET_OPTIONS.medium;

  try {
    const formatted = new Intl.DateTimeFormat(intlLocale, resolvedOptions).format(date);
    if (isPseudoLocale(locale)) {
      return pseudoLocalize(formatted);
    }
    return formatted;
  } catch {
    return date.toISOString().split("T")[0];
  }
}

/**
 * Formats a date and time according to the active locale.
 */
export function formatLocaleDateTime(
  dateInput: Date | string | number,
  locale: Locale | string = "en-US"
): string {
  return formatLocaleDate(dateInput, locale, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
