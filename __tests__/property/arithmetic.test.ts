import * as fc from "fast-check";
import { xlmToStroops } from "@/components/trips/SettlementSummary";
import { validAmountStringArb, validAmountStroopsArb } from "./generators";

describe("Money Arithmetic Property Tests", () => {
  it("converts XLM strings to Stroops exactly", () => {
    fc.assert(
      fc.property(validAmountStringArb, (str) => {
        // Parse manually by scaling string to avoid floating point issues
        const [whole, fraction = ""] = str.split(".");
        const expectedStroops = BigInt(whole) * 10_000_000n + BigInt(fraction.padEnd(7, "0").slice(0, 7));

        const result = xlmToStroops(str);
        expect(result).toBe(expectedStroops.toString());
      }),
      { numRuns: 100 }
    );
  });

  it("converts XLM numbers to Stroops exactly (with 7 decimals limit)", () => {
    fc.assert(
      fc.property(validAmountStringArb, (str) => {
        const num = parseFloat(str);
        const resultFromNum = xlmToStroops(num);
        const resultFromStr = xlmToStroops(str);

        expect(resultFromNum).toBe(resultFromStr);
      }),
      { numRuns: 100 }
    );
  });

  it("round-trips: parse(format(x)) === x", () => {
    fc.assert(
      fc.property(validAmountStroopsArb, (stroops) => {
        // Format to XLM string
        const str = stroops.toString().padStart(8, "0");
        const whole = str.slice(0, -7) || "0";
        const frac = str.slice(-7);
        const xlmStr = `${whole}.${frac}`;

        // Parse back to stroops
        const parsedStroops = xlmToStroops(xlmStr);

        expect(parsedStroops).toBe(stroops.toString());
      }),
      { numRuns: 100 }
    );
  });

  it("proves BigInt stroop summation is commutative and associative (no rounding drift)", () => {
    fc.assert(
      fc.property(
        fc.array(validAmountStringArb, { minLength: 2, maxLength: 50 }),
        (amountStrings) => {
          // 1. BigInt summation (commutative & associative)
          const stroopSums = amountStrings.map((s) => BigInt(xlmToStroops(s)));
          const sum1 = stroopSums.reduce((acc, s) => acc + s, 0n);

          // Shuffle the order
          const shuffledStroopSums = [...stroopSums].sort(() => Math.random() - 0.5);
          const sum2 = shuffledStroopSums.reduce((acc, s) => acc + s, 0n);

          expect(sum1).toBe(sum2);

          // 2. Float summation (might drift due to floating point arithmetic)
          const floatSums = amountStrings.map((s) => parseFloat(s));
          const fSum1 = floatSums.reduce((acc, f) => acc + f, 0);

          const shuffledFloatSums = [...floatSums].sort(() => Math.random() - 0.5);
          const fSum2 = shuffledFloatSums.reduce((acc, f) => acc + f, 0);

          // The BigInt sums are EXACTLY identical
          expect(sum1.toString()).toBe(sum2.toString());
          
          // While float sums might not match exactly due to floating point rounding (we check closeness)
          expect(fSum1).toBeCloseTo(fSum2, 2); // Close, but floats can have precision limits
        }
      ),
      { numRuns: 50 }
    );
  });
});
