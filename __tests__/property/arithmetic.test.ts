import * as fc from "fast-check";
import {
  Amount,
  parse,
  add,
  sub,
  mul,
  div,
  format,
  compare,
  sum,
  min,
  max,
  toScVal,
  fromScVal,
  MAX_AMOUNT_STROOPS,
  MIN_AMOUNT_STROOPS,
} from "@/lib/money/amount";
import { validAmountStringArb, validAmountStroopsArb } from "./generators";

describe("Seam S2 Money Arithmetic Property Tests", () => {
  it("Invariant 1 & 2: Lossless round-trip parse(format(x)) === x", () => {
    fc.assert(
      fc.property(validAmountStroopsArb, (stroops) => {
        const amt = Amount.fromStroops(stroops);
        const formatted = format(amt);
        const parsed = parse(formatted);

        expect(parsed.stroops).toBe(stroops);
        expect(compare(parsed, amt)).toBe(0);
      }),
      { numRuns: 100 },
    );
  });

  it("Invariant 3: Addition is associative and commutative over any permutation", () => {
    fc.assert(
      fc.property(
        fc.array(validAmountStringArb, { minLength: 2, maxLength: 30 }),
        (amountStrings) => {
          const amounts = amountStrings.map((s) => parse(s));

          // Sum in original order
          const sumOriginal = amounts.reduce((acc, a) => add(acc, a), Amount.zero());

          // Sum in shuffled order
          const shuffled = [...amounts].sort(() => Math.random() - 0.5);
          const sumShuffled = shuffled.reduce((acc, a) => add(acc, a), Amount.zero());

          // Sum using helper
          const sumHelper = sum(shuffled);

          expect(sumOriginal.stroops).toBe(sumShuffled.stroops);
          expect(sumOriginal.stroops).toBe(sumHelper.stroops);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Subtraction is exact inverse of addition: add(sub(a, b), b) === a", () => {
    fc.assert(
      fc.property(validAmountStringArb, validAmountStringArb, (strA, strB) => {
        const a = parse(strA);
        const b = parse(strB);

        const diff = sub(a, b);
        const restored = add(diff, b);

        expect(restored.stroops).toBe(a.stroops);
      }),
      { numRuns: 100 },
    );
  });

  it("Invariant 4: Explicit rounding modes produce exact deterministic division", () => {
    fc.assert(
      fc.property(
        validAmountStringArb,
        fc.integer({ min: 1, max: 100 }),
        (strAmount, divisor) => {
          const a = parse(strAmount);
          const qTrunc = div(a, divisor, "truncate");
          const qHalfEven = div(a, divisor, "half_even");
          const qCeil = div(a, divisor, "ceil");
          const qFloor = div(a, divisor, "floor");

          expect(qTrunc.stroops).toBeGreaterThanOrEqual(0n);
          expect(qFloor.stroops).toBeLessThanOrEqual(qCeil.stroops);
          expect(qHalfEven.stroops).toBeGreaterThanOrEqual(qFloor.stroops);
          expect(qHalfEven.stroops).toBeLessThanOrEqual(qCeil.stroops);
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Invariant 5: Values up to MAX_AMOUNT_STROOPS are representable without loss", () => {
    const maxAmt = Amount.fromStroops(MAX_AMOUNT_STROOPS);
    const minAmt = Amount.fromStroops(MIN_AMOUNT_STROOPS);

    expect(maxAmt.stroops).toBe(MAX_AMOUNT_STROOPS);
    expect(minAmt.stroops).toBe(MIN_AMOUNT_STROOPS);

    const formattedMax = format(maxAmt);
    const parsedMax = parse(formattedMax);
    expect(parsedMax.stroops).toBe(MAX_AMOUNT_STROOPS);

    expect(() => Amount.fromStroops(MAX_AMOUNT_STROOPS + 1n)).toThrow(RangeError);
    expect(() => Amount.fromStroops(MIN_AMOUNT_STROOPS - 1n)).toThrow(RangeError);
  });

  it("Comparison defines a total ordering", () => {
    fc.assert(
      fc.property(validAmountStringArb, validAmountStringArb, (strA, strB) => {
        const a = parse(strA);
        const b = parse(strB);

        const cmp = compare(a, b);
        if (a.stroops < b.stroops) {
          expect(cmp).toBe(-1);
          expect(compare(b, a)).toBe(1);
        } else if (a.stroops > b.stroops) {
          expect(cmp).toBe(1);
          expect(compare(b, a)).toBe(-1);
        } else {
          expect(cmp).toBe(0);
          expect(compare(b, a)).toBe(0);
        }
      }),
      { numRuns: 100 },
    );
  });

  it("min and max helper functions work as expected", () => {
    fc.assert(
      fc.property(
        fc.array(validAmountStringArb, { minLength: 1, maxLength: 20 }),
        (amountStrings) => {
          const amounts = amountStrings.map((s) => parse(s));
          const minimum = min(...amounts);
          const maximum = max(...amounts);

          amounts.forEach((a) => {
            expect(a.stroops).toBeGreaterThanOrEqual(minimum.stroops);
            expect(a.stroops).toBeLessThanOrEqual(maximum.stroops);
          });
        },
      ),
      { numRuns: 100 },
    );
  });

  it("Soroban ScVal round-trip conversion is lossless", () => {
    fc.assert(
      fc.property(validAmountStroopsArb, (stroops) => {
        const amt = Amount.fromStroops(stroops);
        const scVal = toScVal(amt, "i128");
        const restored = fromScVal(scVal);

        expect(restored.stroops).toBe(stroops);
      }),
      { numRuns: 100 },
    );
  });
});
