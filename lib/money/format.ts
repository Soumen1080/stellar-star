import { type AssetRef } from "@/lib/stellar/assets";
import { divideBigInt } from "./amount";

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
    const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 2;
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
  amount: number | string | bigint | { stroops: bigint; format?: (decimals?: number) => string },
  asset: string,
  locale: string,
  options: { showExact?: boolean } = {}
): FormatMoneyResult {
  if (options.showExact) {
    return formatExact(amount, asset, locale);
  }

  const config = getAssetConfig(asset);
  let amountNum: number;

  if (typeof amount === "number") {
    amountNum = amount;
  } else if (typeof amount === "bigint") {
    amountNum = Number(amount);
  } else if (amount && typeof amount === "object" && "format" in amount && typeof amount.format === "function") {
    amountNum = parseFloat(amount.format(config.decimals));
  } else {
    amountNum = parseFloat(String(amount));
  }

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
  amount: number | string | bigint | { stroops: bigint; format?: (decimals?: number) => string },
  asset: string,
  locale: string
): FormatMoneyResult {
  let amountStr: string;
  if (amount && typeof amount === "object" && "format" in amount && typeof amount.format === "function") {
    amountStr = amount.format();
  } else {
    amountStr = String(amount).trim();
  }

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
 * Uses the Largest Remainder Method (Hare-Niemeyer) with exact BigInt integer scaling.
 */
export function adjustAmountsForDisplay(
  amounts: string[],
  total: string,
  asset: string
): string[] {
  const config = getAssetConfig(asset);
  const decimals = config.decimals;

  if (amounts.length === 0) return amounts;

  const baseDecimals = 7;
  const scale = 10n ** BigInt(baseDecimals);

  function parseToBig(s: string): bigint | null {
    const trimmed = String(s).trim();
    if (!trimmed) return null;
    const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(trimmed);
    if (!match) return null;
    const isNeg = match[1] === "-";
    const whole = BigInt(match[2]);
    const fracStr = (match[3] ?? "").slice(0, baseDecimals).padEnd(baseDecimals, "0");
    const frac = BigInt(fracStr);
    const val = whole * scale + frac;
    return isNeg ? -val : val;
  }

  const parsedTotal = parseToBig(total);
  const parsedAmounts = amounts.map(parseToBig);

  if (parsedTotal === null || parsedAmounts.some((a) => a === null)) {
    return amounts;
  }

  const diffDecimals = baseDecimals - decimals;
  const divisor = 10n ** BigInt(diffDecimals >= 0 ? diffDecimals : 0);

  // Target total in display scale
  const targetTotalScaled = divideBigInt(parsedTotal, divisor, "half_even");

  const scaledAmounts: bigint[] = [];
  const remainders: Array<{ index: number; rem: bigint }> = [];
  let sumScaled = 0n;

  for (let i = 0; i < parsedAmounts.length; i++) {
    const val = parsedAmounts[i]!;
    const base = val / divisor;
    const rem = val % divisor;
    scaledAmounts.push(base);
    remainders.push({ index: i, rem: rem < 0n ? -rem : rem });
    sumScaled += base;
  }

  const difference = targetTotalScaled - sumScaled;

  if (difference > 0n) {
    remainders.sort((a, b) => (b.rem > a.rem ? 1 : b.rem < a.rem ? -1 : a.index - b.index));
    const count = Number(difference);
    for (let i = 0; i < count; i++) {
      const idx = remainders[i % remainders.length].index;
      scaledAmounts[idx] += 1n;
    }
  } else if (difference < 0n) {
    remainders.sort((a, b) => (a.rem > b.rem ? 1 : a.rem < b.rem ? -1 : a.index - b.index));
    const absDiff = Number(-difference);
    for (let i = 0; i < absDiff; i++) {
      const idx = remainders[i % remainders.length].index;
      scaledAmounts[idx] -= 1n;
    }
  }

  return scaledAmounts.map((v) => {
    const isNeg = v < 0n;
    const absV = isNeg ? -v : v;
    if (decimals === 0) {
      return `${isNeg ? "-" : ""}${absV.toString()}`;
    }
    const decScale = 10n ** BigInt(decimals);
    const wholePart = absV / decScale;
    const fracPart = (absV % decScale).toString().padStart(decimals, "0");
    const sign = isNeg ? "-" : "";
    return `${sign}${wholePart.toString()}.${fracPart}`;
  });
}

