import { isValidXLMAmount } from "@/lib/split/calculator";
import { parseLocaleAmount } from "@/lib/i18n/parseAmount";

/**
 * Validates that an amount string is a finite, positive number greater than zero,
 * using locale-aware parsing to disambiguate decimal and thousands grouping.
 * Returns an error message string if invalid or ambiguous, or null if valid.
 */
export function validateAmount(
  amount: string,
  currency: string,
  locale: string = "en-US"
): string | null {
  const trimmed = amount.trim();
  if (!trimmed) {
    return `Enter a valid ${currency} amount.`;
  }

  const parsed = parseLocaleAmount(trimmed, locale);
  if (!parsed.success || !parsed.canonicalAmount || parsed.value === undefined) {
    return parsed.error ?? `Enter a valid ${currency} amount.`;
  }

  if (Number.isNaN(parsed.value) || !Number.isFinite(parsed.value) || parsed.value <= 0) {
    return `Enter a valid ${currency} amount greater than zero.`;
  }

  if (currency === "XLM" && !isValidXLMAmount(parsed.canonicalAmount)) {
    return "Enter a valid XLM amount (max 7 decimal places, e.g. 10.5).";
  }

  return null;
}
