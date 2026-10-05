import { SUPPORTED_FIAT } from "@/lib/fx/currencies";
import { divideBigInt, type RoundingMode } from "./money";

export const STELLAR_LEDGER_DECIMALS = 7;

export type AssetAmountKind = "stellar" | "fiat";

export interface AssetPrecisionRule {
  code: string;
  kind: AssetAmountKind;
  displayDecimals: number;
  ledgerDecimals: number | null;
}

const FIAT_CODES = new Set<string>(SUPPORTED_FIAT);
const ZERO_DECIMAL_FIAT = new Set(["JPY", "KRW", "VND"]);

function assetCode(asset: string): string {
  const trimmed = asset.trim();
  if (!trimmed || trimmed.toLowerCase() === "native") return "XLM";
  return trimmed.split(":", 1)[0].toUpperCase();
}

/**
 * Keeps presentation precision separate from settlement precision. Classic
 * Stellar assets always settle at 7 decimals; fiat values use their minor-unit
 * precision and can never be submitted directly to the ledger.
 */
export function getAssetPrecision(asset: string): AssetPrecisionRule {
  const issuedAsset = asset.trim().includes(":");
  const code = assetCode(asset);
  if (!issuedAsset && FIAT_CODES.has(code)) {
    const decimals = ZERO_DECIMAL_FIAT.has(code) ? 0 : 2;
    return { code, kind: "fiat", displayDecimals: decimals, ledgerDecimals: null };
  }

  return {
    code,
    kind: "stellar",
    displayDecimals: code === "USDC" ? 2 : 4,
    ledgerDecimals: STELLAR_LEDGER_DECIMALS,
  };
}

interface ParsedDecimal {
  units: bigint;
  decimals: number;
}

function parseDecimal(value: string | number): ParsedDecimal {
  const text = String(value).trim();
  const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(text);
  if (!match) throw new TypeError(`Invalid decimal amount: "${value}"`);

  const sign = match[1] === "-" ? -1n : 1n;
  const fraction = match[3] ?? "";
  const exponent = Number(match[4] ?? 0);
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 100) {
    throw new RangeError(`Decimal exponent is out of range: "${value}"`);
  }

  let units = BigInt(`${match[2]}${fraction}` || "0") * sign;
  let decimals = fraction.length - exponent;
  if (decimals < 0) {
    units *= 10n ** BigInt(-decimals);
    decimals = 0;
  }
  return { units, decimals };
}

function scaleDecimal(
  value: ParsedDecimal,
  targetDecimals: number,
  rounding: RoundingMode,
): bigint {
  if (value.decimals === targetDecimals) return value.units;
  if (value.decimals < targetDecimals) {
    return value.units * 10n ** BigInt(targetDecimals - value.decimals);
  }
  return divideBigInt(
    value.units,
    10n ** BigInt(value.decimals - targetDecimals),
    rounding,
  );
}

export function formatAssetUnits(units: bigint, decimals: number): string {
  const negative = units < 0n;
  const absolute = negative ? -units : units;
  if (decimals === 0) return `${negative ? "-" : ""}${absolute}`;
  const scale = 10n ** BigInt(decimals);
  const whole = absolute / scale;
  const fraction = (absolute % scale).toString().padStart(decimals, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

export function normalizeDecimalRate(rate: string | number): string | null {
  try {
    const parsed = parseDecimal(rate);
    if (parsed.units <= 0n) return null;
    let units = parsed.units;
    let decimals = parsed.decimals;
    while (decimals > 0 && units % 10n === 0n) {
      units /= 10n;
      decimals--;
    }
    return formatAssetUnits(units, decimals);
  } catch {
    return null;
  }
}

/** Converts a display/input amount through an exact decimal rate. */
export function convertAssetAmount(
  amount: string,
  fromAsset: string,
  toAsset: string,
  rate: string | number,
  rounding: RoundingMode = "half_even",
): string {
  const from = getAssetPrecision(fromAsset);
  const to = getAssetPrecision(toAsset);
  const targetDecimals = to.ledgerDecimals ?? to.displayDecimals;
  const sourceDecimals = from.ledgerDecimals ?? from.displayDecimals;
  const sourceUnits = scaleDecimal(parseDecimal(amount), sourceDecimals, rounding);
  const parsedRate = parseDecimal(rate);
  if (parsedRate.units <= 0n) throw new RangeError("Exchange rate must be positive.");

  const numerator = sourceUnits * parsedRate.units * 10n ** BigInt(targetDecimals);
  const denominator =
    10n ** BigInt(sourceDecimals) * 10n ** BigInt(parsedRate.decimals);
  return formatAssetUnits(divideBigInt(numerator, denominator, rounding), targetDecimals);
}

/** Produces the exact 7-decimal string accepted by classic Stellar operations. */
export function toLedgerAmount(
  amount: string,
  asset: string,
  rounding: RoundingMode = "half_even",
): string {
  const precision = getAssetPrecision(asset);
  if (precision.kind !== "stellar" || precision.ledgerDecimals === null) {
    throw new TypeError(`${precision.code} is a display currency, not a Stellar settlement asset.`);
  }
  return formatAssetUnits(
    scaleDecimal(parseDecimal(amount), precision.ledgerDecimals, rounding),
    precision.ledgerDecimals,
  );
}
