import { isValidXLMAmount } from "@/lib/split/calculator";

/**
 * Validates that an amount string is a finite, positive number greater than zero.
 * Used for settlement-critical forms (expense creation, payments, pool deposits).
 * Returns an error message string if invalid, or null if valid.
 */
export function validateAmount(amount: string, currency: string): string | null {
  const trimmed = amount.trim();
  if (!trimmed) {
    return `Enter a valid ${currency} amount.`;
  }

  const num = parseFloat(trimmed);
  if (Number.isNaN(num) || !Number.isFinite(num) || num <= 0) {
    return `Enter a valid ${currency} amount greater than zero.`;
  }

  if (currency === "XLM" && !isValidXLMAmount(trimmed)) {
    return "Enter a valid XLM amount (max 7 decimal places, e.g. 10.5).";
  }

  return null;
}
