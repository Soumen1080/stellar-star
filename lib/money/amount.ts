/**
 * Seam S2 — Exact arithmetic type for money (Issue #149 / Issue #47).
 *
 * Invariants:
 * 1. No arithmetic on a money value passes through `number` at any point.
 * 2. Round-trip parse(format(x)) === x for all representable values.
 * 3. Addition is associative and commutative over any ordering of a list.
 * 4. Every rounding is explicit at a named call site with a stated mode. No implicit rounding anywhere.
 * 5. Values up to MAX_AMOUNT_STROOPS are representable without loss.
 */

import { nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";

export const DECIMALS = 7;
export const STROOPS_PER_UNIT = 10_000_000n;
export const MAX_AMOUNT_STROOPS = 10_000_000_000_000_000n; // 1e16 stroops (1 billion units)
export const MIN_AMOUNT_STROOPS = -MAX_AMOUNT_STROOPS;

export type RoundingMode =
  | "half_even" // Banker's rounding: round towards nearest even number on tie
  | "half_up"   // Round half towards +infinity
  | "half_down" // Round half towards -infinity
  | "floor"     // Round towards -infinity
  | "ceil"      // Round towards +infinity
  | "truncate"; // Round towards zero

/**
 * Performs integer division with explicit rounding modes.
 */
export function divideBigInt(
  numerator: bigint,
  denominator: bigint,
  mode: RoundingMode = "half_even",
): bigint {
  if (denominator === 0n) {
    throw new RangeError("Division by zero in Money arithmetic.");
  }

  // Handle signs
  const sameSign =
    (numerator >= 0n && denominator > 0n) || (numerator <= 0n && denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;

  const quotient = n / d;
  const remainder = n % d;

  if (remainder === 0n) {
    return sameSign ? quotient : -quotient;
  }

  let roundUp = false;
  const doubleRemainder = remainder * 2n;

  switch (mode) {
    case "truncate":
      roundUp = false;
      break;
    case "floor":
      roundUp = !sameSign;
      break;
    case "ceil":
      roundUp = sameSign;
      break;
    case "half_up":
      if (sameSign) {
        roundUp = doubleRemainder >= d;
      } else {
        roundUp = doubleRemainder > d;
      }
      break;
    case "half_down":
      if (sameSign) {
        roundUp = doubleRemainder > d;
      } else {
        roundUp = doubleRemainder >= d;
      }
      break;
    case "half_even":
    default:
      if (doubleRemainder > d) {
        roundUp = true;
      } else if (doubleRemainder === d) {
        // Tie breaker: round to even quotient
        roundUp = quotient % 2n !== 0n;
      } else {
        roundUp = false;
      }
      break;
  }

  const finalMagnitude = roundUp ? quotient + 1n : quotient;
  return sameSign ? finalMagnitude : -finalMagnitude;
}

/**
 * Parses decimal fraction string to BigInt scaled to `decimals`.
 */
function parseFractionToBigInt(fractionStr: string, decimals: number): bigint {
  if (fractionStr.length > decimals) {
    throw new RangeError(
      `Decimal precision (${fractionStr.length}) exceeds maximum allowed precision (${decimals})`,
    );
  }
  const padded = fractionStr.padEnd(decimals, "0");
  return BigInt(padded);
}

/**
 * Immutable exact money representation.
 */
export class Amount {
  readonly stroops: bigint;
  readonly decimals: number;

  constructor(stroops: bigint, decimals: number = DECIMALS) {
    if (stroops > MAX_AMOUNT_STROOPS || stroops < MIN_AMOUNT_STROOPS) {
      throw new RangeError(
        `Amount value ${stroops.toString()} stroops exceeds maximum representable range [${MIN_AMOUNT_STROOPS}, ${MAX_AMOUNT_STROOPS}].`,
      );
    }
    this.stroops = stroops;
    this.decimals = decimals;
    Object.freeze(this);
  }

  static fromStroops(stroops: bigint | number | string, decimals: number = DECIMALS): Amount {
    if (typeof stroops === "bigint") {
      return new Amount(stroops, decimals);
    }
    if (typeof stroops === "number") {
      if (!Number.isSafeInteger(stroops)) {
        throw new TypeError(`Expected safe integer stroops, received unsafe number: ${stroops}`);
      }
      return new Amount(BigInt(stroops), decimals);
    }
    if (typeof stroops === "string") {
      const trimmed = stroops.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new TypeError(`Invalid integer stroops string: "${stroops}"`);
      }
      return new Amount(BigInt(trimmed), decimals);
    }
    throw new TypeError(`Cannot create Amount from: ${typeof stroops}`);
  }

  static zero(decimals: number = DECIMALS): Amount {
    return new Amount(0n, decimals);
  }

  /**
   * Converts a Soroban ScVal (i128 or i64) back to Amount.
   */
  static fromScVal(scVal: xdr.ScVal, decimals: number = DECIMALS): Amount {
    const raw = scValToNative(scVal);
    if (typeof raw === "bigint") {
      return new Amount(raw, decimals);
    }
    if (typeof raw === "number") {
      return new Amount(BigInt(raw), decimals);
    }
    throw new TypeError(`Unsupported ScVal native type for Amount: ${typeof raw}`);
  }

  toScVal(type: "i128" | "i64" = "i128"): xdr.ScVal {
    return nativeToScVal(this.stroops, { type });
  }

  toStroops(): bigint {
    return this.stroops;
  }

  format(decimals: number = this.decimals): string {
    return format(this, decimals);
  }

  toString(): string {
    return this.format(this.decimals);
  }

  toJSON(): string {
    return this.format(this.decimals);
  }

  plus(other: Amount | string | bigint | number): Amount {
    return add(this, toAmount(other, this.decimals));
  }

  minus(other: Amount | string | bigint | number): Amount {
    return sub(this, toAmount(other, this.decimals));
  }

  times(scalar: bigint | number, mode: RoundingMode = "half_even"): Amount {
    return mul(this, scalar, mode);
  }

  dividedBy(divisor: bigint | number, mode: RoundingMode = "half_even"): Amount {
    return div(this, divisor, mode);
  }

  abs(): Amount {
    return this.stroops < 0n ? new Amount(-this.stroops, this.decimals) : this;
  }

  negate(): Amount {
    return new Amount(-this.stroops, this.decimals);
  }

  equals(other: Amount | string | bigint | number): boolean {
    try {
      const o = toAmount(other, this.decimals);
      return this.stroops === o.stroops;
    } catch {
      return false;
    }
  }

  lessThan(other: Amount | string | bigint | number): boolean {
    return compare(this, toAmount(other, this.decimals)) < 0;
  }

  lessThanOrEqual(other: Amount | string | bigint | number): boolean {
    return compare(this, toAmount(other, this.decimals)) <= 0;
  }

  greaterThan(other: Amount | string | bigint | number): boolean {
    return compare(this, toAmount(other, this.decimals)) > 0;
  }

  greaterThanOrEqual(other: Amount | string | bigint | number): boolean {
    return compare(this, toAmount(other, this.decimals)) >= 0;
  }

  isZero(): boolean {
    return this.stroops === 0n;
  }

  isPositive(): boolean {
    return this.stroops > 0n;
  }

  isNegative(): boolean {
    return this.stroops < 0n;
  }

  split(parts: number): Amount[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new RangeError(`Number of split parts must be a positive integer, got ${parts}`);
    }

    const n = BigInt(parts);
    const baseShare = this.stroops / n;
    const remainder = this.stroops % n;

    const result: Amount[] = [];
    const step = this.stroops >= 0n ? 1n : -1n;
    const absRemainder = remainder < 0n ? -remainder : remainder;

    for (let i = 0; i < parts; i++) {
      if (BigInt(i) < absRemainder) {
        result.push(new Amount(baseShare + step, this.decimals));
      } else {
        result.push(new Amount(baseShare, this.decimals));
      }
    }

    return result;
  }

  splitByWeights(weights: number[]): Amount[] {
    if (weights.length === 0) return [];
    if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
      throw new RangeError("Split weights must be non-negative finite numbers.");
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      return this.split(weights.length);
    }

    // Convert weights to scaled bigints
    const bigWeights = weights.map((w) => {
      const s = w.toFixed(7);
      const dot = s.indexOf(".");
      const whole = BigInt(s.slice(0, dot));
      const frac = BigInt(s.slice(dot + 1));
      return whole * 10_000_000n + frac;
    });
    const totalBigWeight = bigWeights.reduce((s, w) => s + w, 0n);

    if (totalBigWeight === 0n) {
      return this.split(weights.length);
    }

    const shares: bigint[] = [];
    const remainders: Array<{ index: number; remainder: bigint }> = [];
    let allocated = 0n;

    for (let i = 0; i < weights.length; i++) {
      const numerator = this.stroops * bigWeights[i];
      const base = numerator / totalBigWeight;
      const rem = numerator % totalBigWeight;
      shares.push(base);
      remainders.push({ index: i, remainder: rem < 0n ? -rem : rem });
      allocated += base;
    }

    const unallocated = this.stroops - allocated;
    const step = this.stroops >= 0n ? 1n : -1n;
    const absUnallocated = unallocated < 0n ? -unallocated : unallocated;

    remainders.sort((a, b) =>
      b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index,
    );

    for (let i = 0; i < Number(absUnallocated); i++) {
      const idx = remainders[i % remainders.length].index;
      shares[idx] += step;
    }

    return shares.map((s) => new Amount(s, this.decimals));
  }
}

/**
 * Seam S2: parse(s, decimals): Amount
 */
export function parse(
  s: string | number | bigint | Amount | { stroops: bigint; decimals?: number },
  decimals: number = DECIMALS,
): Amount {
  if (s instanceof Amount) {
    return s;
  }
  if (s && typeof s === "object" && "stroops" in s && typeof (s as any).stroops === "bigint") {
    return new Amount((s as any).stroops, decimals);
  }
  if (typeof s === "bigint") {
    const scale = 10n ** BigInt(decimals);
    return new Amount(s * scale, decimals);
  }
  if (typeof s === "number") {
    if (Number.isNaN(s) || !Number.isFinite(s)) {
      throw new TypeError(`Cannot parse invalid number as Amount: ${s}`);
    }
    // Format float number without scientific notation up to `decimals` digits
    const str = s.toFixed(decimals);
    return parse(str, decimals);
  }

  if (typeof s !== "string") {
    throw new TypeError(`Cannot parse non-string as Amount: ${typeof s}`);
  }

  const trimmed = s.trim();
  if (trimmed === "") {
    throw new TypeError("Cannot parse empty string as Amount.");
  }

  const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(trimmed);
  if (!match) {
    throw new TypeError(`Invalid decimal money string: "${s}"`);
  }

  const isNegative = match[1] === "-";
  const wholeStr = match[2];
  const fractionStr = match[3] ?? "";

  const scale = 10n ** BigInt(decimals);
  const whole = BigInt(wholeStr);
  const fraction = parseFractionToBigInt(fractionStr, decimals);

  const totalStroops = whole * scale + fraction;
  return new Amount(isNegative ? -totalStroops : totalStroops, decimals);
}

export function tryParse(value: unknown, decimals: number = DECIMALS): Amount | null {
  try {
    if (value === null || value === undefined) return null;
    return parse(value as any, decimals);
  } catch {
    return null;
  }
}

function toAmount(
  value: Amount | string | bigint | number | { stroops: bigint },
  decimals: number = DECIMALS,
): Amount {
  return value instanceof Amount ? value : parse(value as any, decimals);
}

/**
 * Seam S2: add(a, b): Amount
 */
export function add(a: Amount, b: Amount): Amount {
  return new Amount(a.stroops + b.stroops, a.decimals);
}

/**
 * Seam S2: sub(a, b): Amount
 */
export function sub(a: Amount, b: Amount): Amount {
  return new Amount(a.stroops - b.stroops, a.decimals);
}

/**
 * Seam S2: mul(a, factor, mode): Amount
 */
export function mul(
  a: Amount,
  factor: bigint | number,
  mode: RoundingMode = "half_even",
): Amount {
  if (typeof factor === "bigint") {
    return new Amount(a.stroops * factor, a.decimals);
  }
  if (typeof factor === "number") {
    if (!Number.isFinite(factor)) {
      throw new RangeError(`Multiplication factor must be finite, received: ${factor}`);
    }
    const factorStr = factor.toString();
    const dot = factorStr.indexOf(".");
    if (dot === -1) {
      return new Amount(a.stroops * BigInt(factorStr), a.decimals);
    }
    const factorDecimals = factorStr.length - dot - 1;
    const numerator = BigInt(factorStr.replace(".", ""));
    const denominator = 10n ** BigInt(factorDecimals);
    const product = divideBigInt(a.stroops * numerator, denominator, mode);
    return new Amount(product, a.decimals);
  }
  throw new TypeError(`Unsupported factor type: ${typeof factor}`);
}

/**
 * Seam S2: div(a, divisor, mode): Amount
 */
export function div(
  a: Amount,
  divisor: bigint | number,
  mode: RoundingMode = "half_even",
): Amount {
  if (typeof divisor === "bigint") {
    return new Amount(divideBigInt(a.stroops, divisor, mode), a.decimals);
  }
  if (typeof divisor === "number") {
    if (!Number.isFinite(divisor) || divisor === 0) {
      throw new RangeError(`Division by invalid divisor: ${divisor}`);
    }
    const divisorStr = divisor.toString();
    const dot = divisorStr.indexOf(".");
    if (dot === -1) {
      return new Amount(divideBigInt(a.stroops, BigInt(divisorStr), mode), a.decimals);
    }
    const divisorDecimals = divisorStr.length - dot - 1;
    const numerator = BigInt(divisorStr.replace(".", ""));
    const denominator = 10n ** BigInt(divisorDecimals);
    const quotient = divideBigInt(a.stroops * denominator, numerator, mode);
    return new Amount(quotient, a.decimals);
  }
  throw new TypeError(`Unsupported divisor type: ${typeof divisor}`);
}

/**
 * Seam S2: format(a, decimals): string
 */
export function format(a: Amount, decimals: number = a.decimals): string {
  const isNegative = a.stroops < 0n;
  const absStroops = isNegative ? -a.stroops : a.stroops;
  const scale = 10n ** BigInt(a.decimals);

  const whole = absStroops / scale;
  const fractionStroops = absStroops % scale;

  let fractionStr = fractionStroops.toString().padStart(a.decimals, "0");

  if (decimals < a.decimals) {
    const divisor = 10n ** BigInt(a.decimals - decimals);
    const roundedFraction = divideBigInt(fractionStroops, divisor, "half_even");
    fractionStr = roundedFraction.toString().padStart(decimals, "0");
    if (fractionStr.length > decimals) {
      const adjustedWhole = whole + 1n;
      return `${isNegative ? "-" : ""}${adjustedWhole.toString()}.${"0".repeat(decimals)}`;
    }
  } else if (decimals > a.decimals) {
    fractionStr = fractionStr.padEnd(decimals, "0");
  }

  const sign = isNegative && (whole !== 0n || fractionStroops !== 0n) ? "-" : "";
  return decimals === 0
    ? `${sign}${whole.toString()}`
    : `${sign}${whole.toString()}.${fractionStr}`;
}

/**
 * Seam S2: compare(a, b): -1 | 0 | 1
 */
export function compare(a: Amount, b: Amount): -1 | 0 | 1 {
  if (a.stroops < b.stroops) return -1;
  if (a.stroops > b.stroops) return 1;
  return 0;
}

export function toStroops(a: Amount): bigint {
  return a.stroops;
}

export function fromStroops(
  stroops: bigint | number | string,
  decimals: number = DECIMALS,
): Amount {
  return Amount.fromStroops(stroops, decimals);
}

export function toScVal(a: Amount, type: "i128" | "i64" = "i128"): xdr.ScVal {
  return a.toScVal(type);
}

export function fromScVal(scVal: xdr.ScVal, decimals: number = DECIMALS): Amount {
  return Amount.fromScVal(scVal, decimals);
}

export function sum(items: Iterable<Amount | string | bigint | number>): Amount {
  let total = 0n;
  let dec = DECIMALS;
  for (const item of items) {
    const m = toAmount(item as any);
    total += m.stroops;
    dec = m.decimals;
  }
  return new Amount(total, dec);
}

export function min(...items: Array<Amount | string | bigint | number>): Amount {
  if (items.length === 0) throw new RangeError("min requires at least one argument.");
  let minimum = toAmount(items[0] as any);
  for (let i = 1; i < items.length; i++) {
    const cur = toAmount(items[i] as any);
    if (cur.stroops < minimum.stroops) minimum = cur;
  }
  return minimum;
}

export function max(...items: Array<Amount | string | bigint | number>): Amount {
  if (items.length === 0) throw new RangeError("max requires at least one argument.");
  let maximum = toAmount(items[0] as any);
  for (let i = 1; i < items.length; i++) {
    const cur = toAmount(items[i] as any);
    if (cur.stroops > maximum.stroops) maximum = cur;
  }
  return maximum;
}
