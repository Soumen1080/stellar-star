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

export const STROOPS_PER_UNIT = 10_000_000n;
export const DECIMALS = 7;
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
  const sameSign = (numerator >= 0n && denominator > 0n) || (numerator <= 0n && denominator < 0n);
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
 * An immutable exact money representation storing amounts in integer stroops (10^-7 units).
 */
export class Money {
  readonly stroops: bigint;

  constructor(stroops: bigint) {
    if (stroops > MAX_AMOUNT_STROOPS || stroops < MIN_AMOUNT_STROOPS) {
      throw new RangeError(
        `Money value ${stroops.toString()} stroops exceeds maximum representable range [${MIN_AMOUNT_STROOPS}, ${MAX_AMOUNT_STROOPS}].`,
      );
    }
    this.stroops = stroops;
    Object.freeze(this);
  }

  // ── Factory Constructors ───────────────────────────────────────────────────

  /** Creates Money from an integer count of stroops. */
  static fromStroops(stroops: bigint | number | string): Money {
    if (typeof stroops === "bigint") {
      return new Money(stroops);
    }
    if (typeof stroops === "number") {
      if (!Number.isSafeInteger(stroops)) {
        throw new TypeError(`Expected safe integer stroops, received unsafe number: ${stroops}`);
      }
      return new Money(BigInt(stroops));
    }
    if (typeof stroops === "string") {
      const trimmed = stroops.trim();
      if (!/^-?\d+$/.test(trimmed)) {
        throw new TypeError(`Invalid integer stroops string: "${stroops}"`);
      }
      return new Money(BigInt(trimmed));
    }
    throw new TypeError(`Cannot create Money from: ${typeof stroops}`);
  }

  /**
   * Parses a decimal money string (e.g. "123.4567890", "0.5", "-10") into exact Money.
   * Does NOT pass through floating-point `number` at any point.
   */
  static parse(value: string | number | bigint | Money): Money {
    if (value instanceof Money) {
      return value;
    }
    if (typeof value === "bigint") {
      // BigInt alone represents whole units when passed to parse (1n -> 10_000_000 stroops)
      return new Money(value * STROOPS_PER_UNIT);
    }
    if (typeof value === "number") {
      if (Number.isNaN(value) || !Number.isFinite(value)) {
        throw new TypeError(`Cannot parse invalid number as Money: ${value}`);
      }
      value = value.toString();
    }

    if (typeof value !== "string") {
      throw new TypeError(`Cannot parse non-string as Money: ${typeof value}`);
    }

    const trimmed = value.trim();
    if (trimmed === "") {
      throw new TypeError("Cannot parse empty string as Money.");
    }

    const match = /^(-)?(\d+)(?:\.(\d*))?$/.exec(trimmed);
    if (!match) {
      throw new TypeError(`Invalid decimal money string: "${value}"`);
    }

    const isNegative = match[1] === "-";
    const wholeStr = match[2];
    const fractionStr = match[3] ?? "";

    if (fractionStr.length > DECIMALS) {
      throw new RangeError(
        `Decimal precision exceeds ${DECIMALS} digits for amount: "${value}"`,
      );
    }

    const whole = BigInt(wholeStr);
    const paddedFraction = fractionStr.padEnd(DECIMALS, "0");
    const fraction = BigInt(paddedFraction);

    const totalStroops = whole * STROOPS_PER_UNIT + fraction;
    return new Money(isNegative ? -totalStroops : totalStroops);
  }

  /**
   * Safely tries to parse a money string, returning null if invalid.
   */
  static tryParse(value: unknown): Money | null {
    try {
      if (value === null || value === undefined) return null;
      return Money.parse(value as any);
    } catch {
      return null;
    }
  }

  static zero(): Money {
    return new Money(0n);
  }

  /** Converts a Soroban ScVal (i128 or i64) back to Money. */
  static fromScVal(scVal: xdr.ScVal): Money {
    const raw = scValToNative(scVal);
    if (typeof raw === "bigint") {
      return new Money(raw);
    }
    if (typeof raw === "number") {
      return new Money(BigInt(raw));
    }
    throw new TypeError(`Unsupported ScVal native type for Money: ${typeof raw}`);
  }

  // ── Conversions & Formatting ───────────────────────────────────────────────

  /** Converts to Soroban ScVal (defaults to i128). */
  toScVal(type: "i128" | "i64" = "i128"): xdr.ScVal {
    return nativeToScVal(this.stroops, { type });
  }

  /** Returns raw integer stroops as a BigInt. */
  toStroops(): bigint {
    return this.stroops;
  }

  /**
   * Formats the money value to an exact decimal string.
   * Round-trip guarantee: Money.parse(m.format()) === m for all representable values.
   */
  format(decimals = DECIMALS): string {
    const isNegative = this.stroops < 0n;
    const absStroops = isNegative ? -this.stroops : this.stroops;

    const whole = absStroops / STROOPS_PER_UNIT;
    const fractionStroops = absStroops % STROOPS_PER_UNIT;

    let fractionStr = fractionStroops.toString().padStart(DECIMALS, "0");

    if (decimals < DECIMALS) {
      // Explicit truncation / rounding for display
      const divisor = 10n ** BigInt(DECIMALS - decimals);
      const roundedFraction = divideBigInt(fractionStroops, divisor, "half_even");
      fractionStr = roundedFraction.toString().padStart(decimals, "0");
      if (fractionStr.length > decimals) {
        // Overflow to whole
        const adjustedWhole = whole + 1n;
        return `${isNegative ? "-" : ""}${adjustedWhole.toString()}.${"0".repeat(decimals)}`;
      }
    } else if (decimals > DECIMALS) {
      fractionStr = fractionStr.padEnd(decimals, "0");
    }

    const sign = isNegative && (whole !== 0n || fractionStroops !== 0n) ? "-" : "";
    return decimals === 0 ? `${sign}${whole.toString()}` : `${sign}${whole.toString()}.${fractionStr}`;
  }

  toString(): string {
    return this.format(DECIMALS);
  }

  toJSON(): string {
    return this.format(DECIMALS);
  }

  // ── Exact Arithmetic Operations ───────────────────────────────────────────

  plus(other: Money | string | bigint | number): Money {
    const o = toMoney(other);
    return new Money(this.stroops + o.stroops);
  }

  minus(other: Money | string | bigint | number): Money {
    const o = toMoney(other);
    return new Money(this.stroops - o.stroops);
  }

  /** Multiplies by a scalar factor with explicit rounding. */
  times(scalar: bigint | number, mode: RoundingMode = "half_even"): Money {
    if (typeof scalar === "bigint") {
      return new Money(this.stroops * scalar);
    }
    if (typeof scalar === "number") {
      if (!Number.isFinite(scalar)) {
        throw new RangeError(`Multiplication scalar must be finite, received: ${scalar}`);
      }
      // Convert number to rational to avoid floating point drift
      const scalarStr = scalar.toString();
      const dot = scalarStr.indexOf(".");
      if (dot === -1) {
        return new Money(this.stroops * BigInt(scalarStr));
      }
      const decimals = scalarStr.length - dot - 1;
      const numerator = BigInt(scalarStr.replace(".", ""));
      const denominator = 10n ** BigInt(decimals);
      const product = divideBigInt(this.stroops * numerator, denominator, mode);
      return new Money(product);
    }
    throw new TypeError(`Unsupported scalar type: ${typeof scalar}`);
  }

  /** Divides by a scalar divisor with explicit rounding. */
  dividedBy(divisor: bigint | number, mode: RoundingMode = "half_even"): Money {
    if (typeof divisor === "bigint") {
      return new Money(divideBigInt(this.stroops, divisor, mode));
    }
    if (typeof divisor === "number") {
      if (!Number.isFinite(divisor) || divisor === 0) {
        throw new RangeError(`Division by invalid divisor: ${divisor}`);
      }
      const divisorStr = divisor.toString();
      const dot = divisorStr.indexOf(".");
      if (dot === -1) {
        return new Money(divideBigInt(this.stroops, BigInt(divisorStr), mode));
      }
      const decimals = divisorStr.length - dot - 1;
      const numerator = BigInt(divisorStr.replace(".", ""));
      const denominator = 10n ** BigInt(decimals);
      const quotient = divideBigInt(this.stroops * denominator, numerator, mode);
      return new Money(quotient);
    }
    throw new TypeError(`Unsupported divisor type: ${typeof divisor}`);
  }

  abs(): Money {
    return this.stroops < 0n ? new Money(-this.stroops) : this;
  }

  negate(): Money {
    return new Money(-this.stroops);
  }

  // ── Splitting & Allocation (Exact zero-remainder guarantee) ────────────────

  /**
   * Splits an amount into `parts` equal shares, distributing remainder stroops
   * so that sum(shares) === this strictly holds down to the exact stroop.
   */
  split(parts: number): Money[] {
    if (!Number.isInteger(parts) || parts <= 0) {
      throw new RangeError(`Number of split parts must be a positive integer, got ${parts}`);
    }

    const n = BigInt(parts);
    const baseShare = this.stroops / n;
    let remainder = this.stroops % n;

    const result: Money[] = [];
    const step = this.stroops >= 0n ? 1n : -1n;
    const absRemainder = remainder < 0n ? -remainder : remainder;

    for (let i = 0; i < parts; i++) {
      if (BigInt(i) < absRemainder) {
        result.push(new Money(baseShare + step));
      } else {
        result.push(new Money(baseShare));
      }
    }

    return result;
  }

  /**
   * Splits an amount proportionally according to numeric weights using the Largest Remainder Method.
   * Strictly guarantees sum(shares) === this down to the exact stroop.
   */
  splitByWeights(weights: number[]): Money[] {
    if (weights.length === 0) return [];
    if (weights.some((w) => w < 0 || !Number.isFinite(w))) {
      throw new RangeError("Split weights must be non-negative finite numbers.");
    }

    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    if (totalWeight === 0) {
      return this.split(weights.length);
    }

    // Convert weights to scaled bigints to eliminate floating precision
    const scale = 1_000_000n;
    const bigWeights = weights.map((w) => BigInt(Math.round(w * 1_000_000)));
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

    let unallocated = this.stroops - allocated;
    const step = this.stroops >= 0n ? 1n : -1n;
    const absUnallocated = unallocated < 0n ? -unallocated : unallocated;

    // Distribute remainder stroop by stroop in descending order of fractional remainder
    remainders.sort((a, b) => (b.remainder > a.remainder ? 1 : b.remainder < a.remainder ? -1 : a.index - b.index));

    for (let i = 0; i < Number(absUnallocated); i++) {
      const idx = remainders[i % remainders.length].index;
      shares[idx] += step;
    }

    return shares.map((s) => new Money(s));
  }

  // ── Comparison ─────────────────────────────────────────────────────────────

  equals(other: Money | string | bigint | number): boolean {
    try {
      const o = toMoney(other);
      return this.stroops === o.stroops;
    } catch {
      return false;
    }
  }

  lessThan(other: Money | string | bigint | number): boolean {
    return this.stroops < toMoney(other).stroops;
  }

  lessThanOrEqual(other: Money | string | bigint | number): boolean {
    return this.stroops <= toMoney(other).stroops;
  }

  greaterThan(other: Money | string | bigint | number): boolean {
    return this.stroops > toMoney(other).stroops;
  }

  greaterThanOrEqual(other: Money | string | bigint | number): boolean {
    return this.stroops >= toMoney(other).stroops;
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

  // ── Aggregate Helpers ──────────────────────────────────────────────────────

  /**
   * Sums an iterable of Money values in an associative and commutative manner.
   */
  static sum(items: Iterable<Money | string | bigint | number>): Money {
    let total = 0n;
    for (const item of items) {
      total += toMoney(item).stroops;
    }
    return new Money(total);
  }

  static min(...items: Array<Money | string | bigint | number>): Money {
    if (items.length === 0) throw new RangeError("Money.min requires at least one argument.");
    let min = toMoney(items[0]);
    for (let i = 1; i < items.length; i++) {
      const cur = toMoney(items[i]);
      if (cur.stroops < min.stroops) min = cur;
    }
    return min;
  }

  static max(...items: Array<Money | string | bigint | number>): Money {
    if (items.length === 0) throw new RangeError("Money.max requires at least one argument.");
    let max = toMoney(items[0]);
    for (let i = 1; i < items.length; i++) {
      const cur = toMoney(items[i]);
      if (cur.stroops > max.stroops) max = cur;
    }
    return max;
  }
}

function toMoney(value: Money | string | bigint | number): Money {
  return value instanceof Money ? value : Money.parse(value);
}

/** Convenience helper function. */
export function money(value: string | number | bigint | Money): Money {
  return Money.parse(value);
}
