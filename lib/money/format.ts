import { type AssetRef } from "@/lib/stellar/assets";

export interface AssetFormattingConfig {
  decimals: number;
  isFiat: boolean;
  name: string;
}

const ASSET_CONFIGS: Record<string, AssetFormattingConfig> = {
  USD: { decimals: 2, isFiat: true, name: "US Dollars" },
  EUR: { decimals: 2, isFiat: true, name: "Euros" },
  INR: { decimals: 2, isFiat: true, name: "Indian Rupees" },
  JPY: { decimals: 0, isFiat: true, name: "Japanese Yen" },
  XLM: { decimals: 4, isFiat: false, name: "Stellar Lumens" },
  USDC: { decimals: 2, isFiat: false, name: "USDC" },
};

/**
 * Resolves the display decimal places, asset type, and name for any ticker.
 */
export function getAssetConfig(asset: string): AssetFormattingConfig {
  const upper = asset.toUpperCase();
  if (ASSET_CONFIGS[upper]) return ASSET_CONFIGS[upper];

  // Check dynamically if it is a valid ISO currency code
  try {
    const formatter = new Intl.NumberFormat("en-US", { style: "currency", currency: upper });
    const decimals = formatter.resolvedOptions().maximumFractionDigits;
    return { decimals, isFiat: true, name: upper };
  } catch {
    // If invalid, treat as custom crypto token
    return { decimals: 4, isFiat: false, name: upper };
  }
}

export interface FormatMoneyResult {
  formatted: string;
  a11y: string;
}

/**
 * Formats a given monetary amount into a localized display representation.
 */
export function formatMoney(
  amount: number | string | bigint,
  asset: string,
  locale: string,
  options: { showExact?: boolean } = {}
): FormatMoneyResult {
  if (options.showExact) {
    return formatExact(amount, asset, locale);
  }

  const config = getAssetConfig(asset);
  const amountNum = typeof amount === "bigint" ? Number(amount) : parseFloat(String(amount));

  if (isNaN(amountNum)) {
    return { formatted: "—", a11y: "no amount" };
  }

  const decimals = config.decimals;

  if (config.isFiat) {
    const formatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: asset.toUpperCase(),
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    const formatted = formatter.format(amountNum);

    const a11yFormatter = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: asset.toUpperCase(),
      currencyDisplay: "name",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    const a11y = a11yFormatter.format(amountNum);

    return { formatted, a11y };
  } else {
    // Positioning crypto code correctly according to locale
    const usdDummy = new Intl.NumberFormat(locale, {
      style: "currency",
      currency: "USD",
      currencyDisplay: "code",
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(amountNum);

    const formatted = usdDummy.replace("USD", asset.toUpperCase());

    const decFormatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    const a11y = `${decFormatter.format(amountNum)} ${config.name}`;

    return { formatted, a11y };
  }
}

/**
 * Formats full-precision values (e.g. up to 7 decimal places for XLM) for confirmation screens
 * using BigInt for the integer portion and exact string parsing to avoid float limits.
 */
export function formatExact(
  amount: number | string | bigint,
  asset: string,
  locale: string
): FormatMoneyResult {
  const amountStr = String(amount).trim();
  const isNegative = amountStr.startsWith("-");
  const cleanAmountStr = isNegative ? amountStr.slice(1) : amountStr;

  const parts = cleanAmountStr.split(".");
  const integerPart = parts[0] || "0";
  const fractionalPart = parts[1] || "";

  let integerVal = 0n;
  try {
    integerVal = BigInt(integerPart);
  } catch {
    // fallback if not a clean integer
    integerVal = BigInt(Math.floor(parseFloat(integerPart) || 0));
  }

  const intFormatter = new Intl.NumberFormat(locale, { useGrouping: true });
  let formattedInteger = intFormatter.format(integerVal);

  if (isNegative) {
    const negSign = new Intl.NumberFormat(locale).format(-1).replace(/1/g, "").trim() || "-";
    formattedInteger = `${negSign}${formattedInteger}`;
  }

  let formatted = formattedInteger;
  if (fractionalPart) {
    const decimalSeparator = new Intl.NumberFormat(locale).format(0.1).replace(/[0-9]/g, "").trim() || ".";
    formatted = `${formattedInteger}${decimalSeparator}${fractionalPart}`;
  }

  const config = getAssetConfig(asset);
  const assetName = config.name;

  if (config.isFiat) {
    const usdDummy = new Intl.NumberFormat(locale, { style: "currency", currency: asset.toUpperCase() }).format(1);
    const partsOfDummy = new Intl.NumberFormat(locale, { style: "currency", currency: asset.toUpperCase() }).formatToParts(1);
    const currencySymbol = partsOfDummy.find(p => p.type === "currency")?.value || "";
    const isSymbolPrepended = usdDummy.indexOf(currencySymbol) < usdDummy.indexOf("1");
    const hasSpace = usdDummy.includes(" ") || usdDummy.includes("\u00a0");

    const spacing = hasSpace ? " " : "";
    let fiatFormatted = "";
    if (isSymbolPrepended) {
      fiatFormatted = `${currencySymbol}${spacing}${formatted}`;
    } else {
      fiatFormatted = `${formatted}${spacing}${currencySymbol}`;
    }

    return {
      formatted: fiatFormatted,
      a11y: `${formatted} ${asset.toUpperCase()}`,
    };
  } else {
    const usdDummy = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "code" }).format(1);
    const isCodePrepended = usdDummy.indexOf("USD") < usdDummy.indexOf("1");
    const hasSpace = usdDummy.includes(" ") || usdDummy.includes("\u00a0");

    const spacing = hasSpace ? " " : "";
    let cryptoFormatted = "";
    if (isCodePrepended) {
      cryptoFormatted = `${asset.toUpperCase()}${spacing}${formatted}`;
    } else {
      cryptoFormatted = `${formatted}${spacing}${asset.toUpperCase()}`;
    }

    return {
      formatted: cryptoFormatted,
      a11y: `${formatted} ${assetName}`,
    };
  }
}

/**
 * Adjusts a list of component amounts (as strings) so that when formatted to the asset's
 * display decimal places, they sum exactly to the formatted total amount.
 * Uses the Largest Remainder Method (Hare-Niemeyer).
 */
export function adjustAmountsForDisplay(
  amounts: string[],
  total: string,
  asset: string
): string[] {
  const config = getAssetConfig(asset);
  const decimals = config.decimals;
  const factor = Math.pow(10, decimals);

  const parsedTotal = parseFloat(total);
  const parsedAmounts = amounts.map(a => parseFloat(a));

  if (isNaN(parsedTotal) || parsedAmounts.some(isNaN) || amounts.length === 0) {
    return amounts;
  }

  const targetTotalScaled = Math.round(parsedTotal * factor);
  const scaledAmounts = parsedAmounts.map(a => Math.round(a * factor));

  const sumScaled = scaledAmounts.reduce((sum, val) => sum + val, 0);
  let difference = targetTotalScaled - sumScaled;

  if (difference === 0) {
    return scaledAmounts.map(v => (v / factor).toFixed(decimals));
  }

  const errors = parsedAmounts.map((val, index) => {
    const originalScaled = val * factor;
    const roundedScaled = scaledAmounts[index];
    return {
      index,
      error: originalScaled - roundedScaled,
    };
  });

  if (difference > 0) {
    errors.sort((a, b) => b.error - a.error);
    for (let i = 0; i < difference; i++) {
      const idx = errors[i % errors.length].index;
      scaledAmounts[idx] += 1;
    }
  } else {
    errors.sort((a, b) => a.error - b.error);
    const absDiff = Math.abs(difference);
    for (let i = 0; i < absDiff; i++) {
      const idx = errors[i % errors.length].index;
      scaledAmounts[idx] -= 1;
    }
  }

  return scaledAmounts.map(v => (v / factor).toFixed(decimals));
}
