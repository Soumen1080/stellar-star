/**
 * Property-based test suite for Seam S2: Exact Money Arithmetic (Issue #149 / Issue #47).
 *
 * Asserts algebraic properties (associativity, commutativity, distributivity,
 * lossless round-tripping, exact split conservation) over pseudo-randomly generated inputs.
 */

import {
  DECIMALS,
  MAX_AMOUNT_STROOPS,
  MIN_AMOUNT_STROOPS,
  Money,
  STROOPS_PER_UNIT,
  divideBigInt,
  money,
} from "@/lib/money";

// ── Deterministic PRNG for reproducible property-based testing ─────────────────

function createPRNG(seed = 1337) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const random = createPRNG(42);

function randomBigInt(min: bigint, max: bigint): bigint {
  const range = max - min;
  const randNum = BigInt(Math.floor(random() * 1_000_000_000));
  const randScale = BigInt(Math.floor(random() * 1_000_000));
  const combined = (randNum * 1_000_000n + randScale) % (range + 1n);
  return min + combined;
}

function randomMoney(maxStroops = 100_000_000_000_000n): Money {
  const stroops = randomBigInt(-maxStroops, maxStroops);
  return Money.fromStroops(stroops);
}

function randomPositiveMoney(maxStroops = 100_000_000_000_000n): Money {
  const stroops = randomBigInt(1n, maxStroops);
  return Money.fromStroops(stroops);
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

describe("Seam S2: Exact Money Properties", () => {
  // ===========================================================================
  // Property 1: Associativity of Addition
  // (a + b) + c === a + (b + c)
  // ===========================================================================
  describe("Property 1: Associativity of Addition", () => {
    it("addition is strictly associative across generated triples", () => {
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const a = randomMoney();
        const b = randomMoney();
        const c = randomMoney();

        const left = a.plus(b).plus(c);
        const right = a.plus(b.plus(c));

        expect(left.stroops).toBe(right.stroops);
        expect(left.equals(right)).toBe(true);
      }
    });

    it("addition is associative on edge-case amounts (0.1, 0.2, 0.3)", () => {
      const a = Money.parse("0.1");
      const b = Money.parse("0.2");
      const c = Money.parse("0.3");

      expect(a.plus(b).format()).toBe("0.3000000");
      expect(a.plus(b).plus(c).format()).toBe("0.6000000");
      expect(a.plus(b.plus(c)).format()).toBe("0.6000000");
    });
  });

  // ===========================================================================
  // Property 2: Commutativity of Addition
  // a + b === b + a and sum(shuffle(L)) === sum(L)
  // ===========================================================================
  describe("Property 2: Commutativity of Addition & Permutation Invariance", () => {
    it("pairwise addition is strictly commutative across generated pairs", () => {
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const a = randomMoney();
        const b = randomMoney();

        const ab = a.plus(b);
        const ba = b.plus(a);

        expect(ab.stroops).toBe(ba.stroops);
        expect(ab.equals(ba)).toBe(true);
      }
    });

    it("list aggregation is invariant under arbitrary permutations", () => {
      const listSize = 25;
      const testListsCount = 100;

      for (let i = 0; i < testListsCount; i++) {
        const list: Money[] = [];
        for (let j = 0; j < listSize; j++) {
          list.push(randomMoney());
        }

        const canonicalSum = Money.sum(list);

        for (let p = 0; p < 5; p++) {
          const permuted = shuffle(list);
          const permutedSum = Money.sum(permuted);

          expect(permutedSum.stroops).toBe(canonicalSum.stroops);
          expect(permutedSum.equals(canonicalSum)).toBe(true);
        }
      }
    });
  });

  // ===========================================================================
  // Property 3: Lossless Round-Tripping (Invariant 2)
  // parse(format(x)) === x for all representable values
  // ===========================================================================
  describe("Property 3: Lossless Round-Tripping", () => {
    it("round-trips parse(format(x)) === x for arbitrary generated values", () => {
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const original = randomMoney(MAX_AMOUNT_STROOPS);
        const formatted = original.format();
        const parsed = Money.parse(formatted);

        expect(parsed.stroops).toBe(original.stroops);
        expect(parsed.equals(original)).toBe(true);
        expect(parsed.format()).toBe(formatted);
      }
    });

    it("round-trips fromStroops(toStroops()) === x exactly", () => {
      const iterations = 500;
      for (let i = 0; i < iterations; i++) {
        const stroops = randomBigInt(MIN_AMOUNT_STROOPS, MAX_AMOUNT_STROOPS);
        const m = Money.fromStroops(stroops);

        expect(m.toStroops()).toBe(stroops);
        expect(Money.fromStroops(m.toStroops()).equals(m)).toBe(true);
      }
    });

    it("round-trips Soroban ScVal serialization without loss", () => {
      const iterations = 200;
      for (let i = 0; i < iterations; i++) {
        const m = randomMoney();
        const scVal = m.toScVal("i128");
        const restored = Money.fromScVal(scVal);

        expect(restored.stroops).toBe(m.stroops);
        expect(restored.equals(m)).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Property 4: Exact Split & Largest Remainder Conservation (Zero Loss)
  // sum(split(M, N)) === M
  // ===========================================================================
  describe("Property 4: Exact Split Allocation (Zero Loss Guarantee)", () => {
    it("conserves total amount down to the exact stroop on equal splits", () => {
      const iterations = 300;
      for (let i = 0; i < iterations; i++) {
        const total = randomPositiveMoney();
        const parts = Math.floor(random() * 50) + 1; // 1 to 50 parts

        const shares = total.split(parts);

        expect(shares).toHaveLength(parts);
        const sum = Money.sum(shares);
        expect(sum.stroops).toBe(total.stroops);
        expect(sum.equals(total)).toBe(true);

        // Verify individual shares differ by at most 1 stroop
        const minShare = Money.min(...shares);
        const maxShare = Money.max(...shares);
        expect(maxShare.stroops - minShare.stroops).toBeLessThanOrEqual(1n);
      }
    });

    it("conserves total amount on weighted custom splits across random weights", () => {
      const iterations = 300;
      for (let i = 0; i < iterations; i++) {
        const total = randomPositiveMoney();
        const count = Math.floor(random() * 10) + 2; // 2 to 11 members
        const weights: number[] = [];
        for (let j = 0; j < count; j++) {
          weights.push(Math.floor(random() * 10) + 1);
        }

        const shares = total.splitByWeights(weights);

        expect(shares).toHaveLength(count);
        const sum = Money.sum(shares);
        expect(sum.stroops).toBe(total.stroops);
        expect(sum.equals(total)).toBe(true);
      }
    });
  });

  // ===========================================================================
  // Property 5: Bounds & No Number Overflow (Invariant 5)
  // Values up to MAX_AMOUNT_STROOPS (1e16 stroops) representable without loss
  // ===========================================================================
  describe("Property 5: Maximum Range & Safe Boundary Handling", () => {
    it("represents MAX_AMOUNT_STROOPS (1e16 stroops) with exact precision", () => {
      const maxMoney = Money.fromStroops(MAX_AMOUNT_STROOPS);
      expect(maxMoney.toStroops()).toBe(10_000_000_000_000_000n);
      expect(maxMoney.format()).toBe("1000000000.0000000");

      const parsedMax = Money.parse("1000000000.0000000");
      expect(parsedMax.toStroops()).toBe(MAX_AMOUNT_STROOPS);
      expect(parsedMax.equals(maxMoney)).toBe(true);
    });

    it("rejects values strictly exceeding MAX_AMOUNT_STROOPS", () => {
      expect(() => Money.fromStroops(MAX_AMOUNT_STROOPS + 1n)).toThrow(RangeError);
      expect(() => Money.fromStroops(MIN_AMOUNT_STROOPS - 1n)).toThrow(RangeError);
      expect(() => Money.parse("1000000000.0000001")).toThrow(RangeError);
    });

    it("handles 0.0000001 (1 stroop) without precision loss", () => {
      const oneStroop = Money.parse("0.0000001");
      expect(oneStroop.toStroops()).toBe(1n);
      expect(oneStroop.format()).toBe("0.0000001");
    });
  });

  // ===========================================================================
  // Property 6: Explicit Rounding Modes (Invariant 4)
  // ===========================================================================
  describe("Property 6: Explicit Division & Multiplication Rounding Modes", () => {
    it("applies half_even (banker's rounding) on ties correctly", () => {
      // 2.5 stroops -> 2 (even)
      expect(divideBigInt(5n, 2n, "half_even")).toBe(2n);
      // 3.5 stroops -> 4 (even)
      expect(divideBigInt(7n, 2n, "half_even")).toBe(4n);
      // 1.5 stroops -> 2 (even)
      expect(divideBigInt(3n, 2n, "half_even")).toBe(2n);
    });

    it("applies half_up rounding correctly", () => {
      expect(divideBigInt(5n, 2n, "half_up")).toBe(3n);
      expect(divideBigInt(7n, 2n, "half_up")).toBe(4n);
    });

    it("applies floor and ceil rounding correctly", () => {
      expect(divideBigInt(5n, 2n, "floor")).toBe(2n);
      expect(divideBigInt(5n, 2n, "ceil")).toBe(3n);
      expect(divideBigInt(-5n, 2n, "floor")).toBe(-3n);
      expect(divideBigInt(-5n, 2n, "ceil")).toBe(-2n);
    });

    it("applies truncate rounding correctly", () => {
      expect(divideBigInt(5n, 2n, "truncate")).toBe(2n);
      expect(divideBigInt(-5n, 2n, "truncate")).toBe(-2n);
    });

    it("multiplication with fractional scalar rounds according to explicit mode", () => {
      const m = Money.fromStroops(10n);
      const half = m.times(0.25, "half_even");
      // 10 * 0.25 = 2.5 -> 2 stroops (half_even to nearest even)
      expect(half.toStroops()).toBe(2n);

      const halfUp = m.times(0.25, "half_up");
      expect(halfUp.toStroops()).toBe(3n);
    });
  });
});
