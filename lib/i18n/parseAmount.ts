import { type Locale } from "./types";

export interface ParseAmountResult {
  success: boolean;
  canonicalAmount?: string;
  value?: number;
  error?: string;
}

/**
 * Mapping of Arabic-Indic and Eastern Arabic-Indic digits to ASCII digits.
 */
const ARABIC_DIGITS: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

/**
 * Normalizes Arabic-Indic digits and Arabic punctuation to standard characters.
 */
function normalizeDigitsAndSeparators(raw: string): string {
  let result = "";
  for (const char of raw) {
    if (ARABIC_DIGITS[char]) {
      result += ARABIC_DIGITS[char];
    } else if (char === "\u066B") {
      // Arabic decimal separator (٫) -> unambiguously decimal point
      result += ".";
    } else if (char === "\u066C") {
      // Arabic thousands separator (٬) -> thousands grouping
      result += ",";
    } else {
      result += char;
    }
  }
  return result;
}

/**
 * Parses user input amounts across various locale conventions into a canonical
 * decimal string (e.g. "1234.56").
 *
 * Invariant: Stored and on-chain values must ALWAYS remain canonical (ASCII digits
 * with "." as decimal separator, no grouping characters). Localized representations
 * are purely for input and display.
 *
 * Prevents ambiguous inputs such as conflicting separators, multiple decimals,
 * or mismatched grouping patterns.
 */
export function parseLocaleAmount(
  rawInput: string,
  locale: Locale | string = "en-US"
): ParseAmountResult {
  if (!rawInput || typeof rawInput !== "string") {
    return { success: false, error: "Amount is required." };
  }

  let text = rawInput.trim();
  if (!text) {
    return { success: false, error: "Amount cannot be empty." };
  }

  // Normalize Arabic-Indic digits and Arabic separators
  text = normalizeDigitsAndSeparators(text);

  // Check for leading negative sign
  const isNegative = text.startsWith("-");
  if (isNegative) {
    text = text.slice(1).trim();
  }

  // Reject consecutive or illegal symbols
  if (text.includes("..") || text.includes(",,") || text.includes(".,") || text.includes(",.")) {
    return { success: false, error: "Invalid amount: consecutive separator characters." };
  }

  // Allow whitespace (space, non-breaking space, thin space) and apostrophe as thousands grouping
  // Replace grouping spaces/apostrophes with temporary token or remove if valid grouping
  const hasWhitespaceGrouping = /[\s\u00A0\u202F']/.test(text);
  if (hasWhitespaceGrouping) {
    // Check that spaces are not misplaced
    const parts = text.split(/[\s\u00A0\u202F']/);
    // If there are multiple parts before decimal
    // E.g. "1 234.50" or "1 234 567"
    text = text.replace(/[\s\u00A0\u202F']/g, "");
  }

  // Check for invalid characters (letters, currency symbols, illegal punctuation)
  if (!/^[0-9.,]+$/.test(text)) {
    return {
      success: false,
      error: "Enter numeric digits only. Currency symbols or letters are not allowed.",
    };
  }

  const dotCount = (text.match(/\./g) || []).length;
  const commaCount = (text.match(/,/g) || []).length;

  const isCommaDecimalLocale = locale.startsWith("de") || locale.startsWith("fr") || locale.startsWith("es") || locale.startsWith("it");

  // CASE 1: Both dot and comma present
  if (dotCount > 0 && commaCount > 0) {
    const lastDot = text.lastIndexOf(".");
    const lastComma = text.lastIndexOf(",");

    if (lastDot < lastComma) {
      // Dots appear before comma -> Dot is thousands separator, comma is decimal (European / German style)
      // E.g. "1.234,56" or "1.234.567,89"
      if (commaCount > 1) {
        return { success: false, error: "Ambiguous amount: multiple decimal commas." };
      }

      const [integerPart, fractionalPart] = text.split(",");
      const groups = integerPart.split(".");

      // First group: 1-3 digits. Subsequent groups: exactly 3 digits.
      if (groups[0].length < 1 || groups[0].length > 3) {
        return { success: false, error: "Ambiguous amount: invalid thousands grouping." };
      }
      for (let i = 1; i < groups.length; i++) {
        if (groups[i].length !== 3) {
          return { success: false, error: "Ambiguous amount: invalid thousands grouping." };
        }
      }

      const canonicalInteger = groups.join("");
      const canonicalAmount = `${isNegative ? "-" : ""}${canonicalInteger}${fractionalPart ? `.${fractionalPart}` : ""}`;
      const value = parseFloat(canonicalAmount);

      return { success: true, canonicalAmount, value };
    } else {
      // Comma appears before dot -> Comma is thousands separator, dot is decimal (US / UK / Indian style)
      // E.g. "1,234.56" or "1,234,567.89" or "1,23,456.78"
      if (dotCount > 1) {
        return { success: false, error: "Ambiguous amount: multiple decimal points." };
      }

      const [integerPart, fractionalPart] = text.split(".");
      const groups = integerPart.split(",");

      // In Indian numbering: first group 1-3 digits, then 2 digits, last group 3 digits.
      // In standard numbering: all groups after first are 3 digits.
      const isIndian = locale === "hi-IN" || locale.startsWith("hi");
      const isValidUS = groups[0].length >= 1 && groups[0].length <= 3 && groups.slice(1).every((g) => g.length === 3);
      const isValidIN =
        groups.length === 2
          ? groups[0].length >= 1 && groups[0].length <= 3 && groups[1].length === 3
          : groups.length > 2
          ? groups[0].length >= 1 &&
            groups[0].length <= 2 &&
            groups.slice(1, -1).every((g) => g.length === 2) &&
            groups[groups.length - 1].length === 3
          : true;

      if (!isValidUS && !(isIndian && isValidIN)) {
        return { success: false, error: "Ambiguous amount: invalid thousands grouping." };
      }

      const canonicalInteger = groups.join("");
      const canonicalAmount = `${isNegative ? "-" : ""}${canonicalInteger}${fractionalPart ? `.${fractionalPart}` : ""}`;
      const value = parseFloat(canonicalAmount);

      return { success: true, canonicalAmount, value };
    }
  }

  // CASE 2: Multiple dots, no commas (e.g. "1.234.567")
  if (dotCount > 1 && commaCount === 0) {
    const groups = text.split(".");
    const allGroupsThree = groups.slice(1).every((g) => g.length === 3);
    if (!allGroupsThree || groups[0].length < 1 || groups[0].length > 3) {
      return { success: false, error: "Ambiguous amount: multiple decimal points or invalid grouping." };
    }
    // Valid German / European thousands grouping with no decimals
    const canonicalAmount = `${isNegative ? "-" : ""}${groups.join("")}`;
    return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
  }

  // CASE 3: Multiple commas, no dots (e.g. "1,234,567")
  if (commaCount > 1 && dotCount === 0) {
    const groups = text.split(",");
    const allGroupsThree = groups.slice(1).every((g) => g.length === 3);
    const isIndian = locale === "hi-IN" || locale.startsWith("hi");
    const isValidIN =
      groups.length > 2 &&
      groups[0].length >= 1 &&
      groups[0].length <= 2 &&
      groups.slice(1, -1).every((g) => g.length === 2) &&
      groups[groups.length - 1].length === 3;

    if (!allGroupsThree && !(isIndian && isValidIN)) {
      return { success: false, error: "Ambiguous amount: multiple commas or invalid grouping." };
    }
    const canonicalAmount = `${isNegative ? "-" : ""}${groups.join("")}`;
    return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
  }

  // CASE 4: Exactly one comma, no dots
  if (commaCount === 1 && dotCount === 0) {
    const [left, right] = text.split(",");

    if (isCommaDecimalLocale) {
      // In German/European locales, comma is the standard decimal separator
      const canonicalAmount = `${isNegative ? "-" : ""}${left || "0"}.${right || "0"}`;
      return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
    }

    // In US/dot-decimal locales:
    // If right side has exactly 3 digits (e.g. "1,234"), it could be a thousand.
    // But if right side has anything other than 3 digits (e.g. "12,5" or "12,50"),
    // comma is clearly ambiguous in US locale (user typed European decimal or invalid grouping).
    if (right.length !== 3) {
      return {
        success: false,
        error: "Ambiguous amount: comma used with non-thousand grouping. Use '.' as decimal separator.",
      };
    }

    // If it is 3 digits e.g. "1,234", in en-US it is thousands 1234
    const canonicalAmount = `${isNegative ? "-" : ""}${left}${right}`;
    return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
  }

  // CASE 5: Exactly one dot, no commas
  if (dotCount === 1 && commaCount === 0) {
    const [left, right] = text.split(".");

    if (isCommaDecimalLocale && right.length === 3 && left.length >= 1 && left.length <= 3) {
      // In German locale: "1.234" has dot followed by 3 digits -> thousands grouping
      const canonicalAmount = `${isNegative ? "-" : ""}${left}${right}`;
      return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
    }

    // Standard decimal notation e.g. "12.50" or "1234.56"
    const canonicalAmount = `${isNegative ? "-" : ""}${left || "0"}.${right || "0"}`;
    return { success: true, canonicalAmount, value: parseFloat(canonicalAmount) };
  }

  // CASE 6: Plain digits only (e.g. "1234")
  const canonicalAmount = `${isNegative ? "-" : ""}${text}`;
  const value = parseFloat(canonicalAmount);
  if (Number.isNaN(value)) {
    return { success: false, error: "Invalid numeric amount." };
  }

  return { success: true, canonicalAmount, value };
}
