/**
 * Property-based test suite for Provably Exact Split Arithmetic (Issue #151 / Issue #49).
 *
 * Invariants Tested:
 * 1. sum(all shares including payer) === total exactly (Zero epsilon)
 * 2. No share is negative
 * 3. Equal weights yield shares differing by at most 1 minor unit (1 stroop)
 * 4. Deterministic and strictly independent of input member array ordering
 * 5. Reordering members permutes the shares but preserves each member's allocation and the multiset of values
 * 6. Adding a member with weight zero assigns them 0 and changes nobody else's share
 * 7. Fractional and extreme weights handle properly without IEEE-754 drift
 */

import {
  apportionShares,
  calculateAllShares,
  calculateCustomSplit,
  calculateEqualSplit,
  calculateSplit,
  getPayerShare,
} from "@/lib/split/calculator";
import { Money, STROOPS_PER_UNIT } from "@/lib/money";
import type { Member } from "@/types/expense";

// ── Deterministic PRNG for property testing ────────────────────────────────────

function createPRNG(seed = 123456) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const random = createPRNG(777);

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number, decimals = 3): number {
  const val = min + random() * (max - min);
  return parseFloat(val.toFixed(decimals));
}

function randomTotalMoney(maxStroops = 100_000_000_000_000n): Money {
  const stroops = BigInt(randomInt(1, 10_000_000)) * BigInt(randomInt(1, 10_000_000));
  return Money.fromStroops(stroops % maxStroops + 1n);
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateMembers(count: number, withWeights = false): Member[] {
  const members: Member[] = [];
  for (let i = 0; i < count; i++) {
    const weight = withWeights ? randomFloat(0, 10, 2) : 1;
    members.push({
      id: `member-${i.toString().padStart(3, "0")}`,
      name: `User ${i}`,
      weight,
      walletAddress: `G_WALLET_${i}`,
    });
  }
  return members;
}

describe("Issue #151: Provably Exact Split Arithmetic Properties", () => {
  // ===========================================================================
  // Invariant 1: Total Conservation (sum(all shares) === total)
  // ===========================================================================
  describe("Invariant 1: Exact Total Conservation (Zero Epsilon)", () => {
    it("conserves total for equal splits across generated member counts (1 to 50)", () => {
      for (let trial = 0; trial < 100; trial++) {
        const memberCount = randomInt(1, 50);
        const members = generateMembers(memberCount);
        const total = randomTotalMoney();
        const payerId = members[randomInt(0, members.length - 1)].id;

        const allShares = calculateAllShares(total, members, "equal");
        const nonPayerShares = calculateEqualSplit(total, members, payerId);
        const payerShare = getPayerShare(total, members, payerId, "equal");

        // Sum of all shares
        const sumAll = Money.sum(allShares.map((s) => s.amount));
        expect(sumAll.stroops).toBe(total.stroops);

        // Sum of non-payers + payer
        const sumNonPayers = Money.sum(nonPayerShares.map((s) => s.amount));
        expect(sumNonPayers.plus(payerShare).stroops).toBe(total.stroops);
      }
    });

    it("conserves total for weighted custom splits across random and fractional weights", () => {
      for (let trial = 0; trial < 100; trial++) {
        const memberCount = randomInt(1, 50);
        const members = generateMembers(memberCount, true);
        const total = randomTotalMoney();
        const payerId = members[randomInt(0, members.length - 1)].id;

        const allShares = calculateAllShares(total, members, "custom");
        const nonPayerShares = calculateCustomSplit(total, members, payerId);
        const payerShare = getPayerShare(total, members, payerId, "custom");

        const sumAll = Money.sum(allShares.map((s) => s.amount));
        expect(sumAll.stroops).toBe(total.stroops);

        const sumNonPayers = Money.sum(nonPayerShares.map((s) => s.amount));
        expect(sumNonPayers.plus(payerShare).stroops).toBe(total.stroops);
      }
    });
  });

  // ===========================================================================
  // Invariant 2: Non-Negativity
  // ===========================================================================
  describe("Invariant 2: Non-Negativity", () => {
    it("never produces a negative share for any participant", () => {
      for (let trial = 0; trial < 50; trial++) {
        const members = generateMembers(randomInt(2, 30), true);
        const total = randomTotalMoney();

        const allShares = calculateAllShares(total, members, "custom");
        for (const share of allShares) {
          const m = Money.parse(share.amount);
          expect(m.isNegative()).toBe(false);
          expect(m.stroops).toBeGreaterThanOrEqual(0n);
        }
      }
    });
  });

  // ===========================================================================
  // Invariant 3: Equal Weights Differ by at Most 1 Minor Unit (1 Stroop)
  // ===========================================================================
  describe("Invariant 3: Equal Weights Difference <= 1 Stroop", () => {
    it("equal split shares differ by at most 1 stroop", () => {
      for (let trial = 0; trial < 50; trial++) {
        const members = generateMembers(randomInt(2, 50), false);
        const total = randomTotalMoney();

        const allShares = calculateAllShares(total, members, "equal");
        const stroopsList = allShares.map((s) => Money.parse(s.amount).stroops);
        const minStroops = stroopsList.reduce((min, cur) => (cur < min ? cur : min), stroopsList[0]);
        const maxStroops = stroopsList.reduce((max, cur) => (cur > max ? cur : max), stroopsList[0]);

        expect(maxStroops - minStroops).toBeLessThanOrEqual(1n);
      }
    });

    it("members with identical weights in custom split differ by at most 1 stroop", () => {
      for (let trial = 0; trial < 50; trial++) {
        const members: Member[] = [
          { id: "m-1", name: "A", weight: 2.5 },
          { id: "m-2", name: "B", weight: 2.5 },
          { id: "m-3", name: "C", weight: 2.5 },
          { id: "m-4", name: "D", weight: 5.0 },
        ];
        const total = randomTotalMoney();

        const shares = calculateAllShares(total, members, "custom");
        const aShare = Money.parse(shares[0].amount).stroops;
        const bShare = Money.parse(shares[1].amount).stroops;
        const cShare = Money.parse(shares[2].amount).stroops;

        expect(Math.abs(Number(aShare - bShare))).toBeLessThanOrEqual(1);
        expect(Math.abs(Number(bShare - cShare))).toBeLessThanOrEqual(1);
        expect(Math.abs(Number(aShare - cShare))).toBeLessThanOrEqual(1);
      }
    });
  });

  // ===========================================================================
  // Invariant 4 & 5: Order-Independence & Determinism
  // ===========================================================================
  describe("Invariant 4 & 5: Order-Independence & Determinism", () => {
    it("reordering the members array preserves exact individual allocations", () => {
      for (let trial = 0; trial < 50; trial++) {
        const members = generateMembers(randomInt(3, 15), true);
        const total = randomTotalMoney();

        const canonicalShares = calculateAllShares(total, members, "custom");
        const canonicalMap = new Map(canonicalShares.map((s) => [s.memberId, s.amount]));

        // Shuffle members array 5 times and check allocations
        for (let s = 0; s < 5; s++) {
          const shuffledMembers = shuffle(members);
          const shuffledShares = calculateAllShares(total, shuffledMembers, "custom");

          for (const share of shuffledShares) {
            expect(share.amount).toBe(canonicalMap.get(share.memberId));
          }
        }
      }
    });

    it("multiset of values is invariant under member permutation", () => {
      for (let trial = 0; trial < 30; trial++) {
        const members = generateMembers(randomInt(3, 12), true);
        const total = randomTotalMoney();

        const canonicalShares = calculateAllShares(total, members, "custom");
        const canonicalValues = canonicalShares.map((s) => s.amount).sort();

        const shuffledMembers = shuffle(members);
        const shuffledShares = calculateAllShares(total, shuffledMembers, "custom");
        const shuffledValues = shuffledShares.map((s) => s.amount).sort();

        expect(shuffledValues).toEqual(canonicalValues);
      }
    });
  });

  // ===========================================================================
  // Invariant 6: Zero-Weight Invariance
  // ===========================================================================
  describe("Invariant 6: Zero-Weight Invariance", () => {
    it("adding a zero-weight member awards them 0 and changes nobody else's share", () => {
      for (let trial = 0; trial < 50; trial++) {
        const members = generateMembers(randomInt(2, 10), true);
        const total = randomTotalMoney();

        const baseShares = calculateAllShares(total, members, "custom");
        const baseMap = new Map(baseShares.map((s) => [s.memberId, s.amount]));

        // Add a member with weight 0
        const zeroMember: Member = {
          id: "m-zero",
          name: "Zero Guy",
          weight: 0,
        };
        const augmentedMembers = [...members, zeroMember];

        const augmentedShares = calculateAllShares(total, augmentedMembers, "custom");
        const zeroShare = augmentedShares.find((s) => s.memberId === "m-zero");

        expect(zeroShare?.amount).toBe("0.0000000");

        // Verify all other members' shares are completely unaffected
        for (const m of members) {
          const augShare = augmentedShares.find((s) => s.memberId === m.id);
          expect(augShare?.amount).toBe(baseMap.get(m.id));
        }
      }
    });
  });

  // ===========================================================================
  // Boundary & Pathological Cases
  // ===========================================================================
  describe("Boundary & Pathological Cases", () => {
    it("handles a single member correctly (member gets 100% of total)", () => {
      const single: Member[] = [{ id: "m-1", name: "Solo", weight: 5 }];
      const total = Money.parse("123.4567890");

      const all = calculateAllShares(total, single, "custom");
      expect(all).toHaveLength(1);
      expect(all[0].amount).toBe("123.4567890");

      // Non-payer list when single is payer is empty
      const nonPayers = calculateCustomSplit(total, single, "m-1");
      expect(nonPayers).toHaveLength(0);
      expect(getPayerShare(total, single, "m-1", "custom").format()).toBe("123.4567890");
    });

    it("handles extreme boundary values up to 1e16 stroops (1 billion XLM)", () => {
      const members = generateMembers(3, false);
      const maxTotal = Money.fromStroops(10_000_000_000_000_000n);

      const shares = calculateAllShares(maxTotal, members, "equal");
      const sum = Money.sum(shares.map((s) => s.amount));

      expect(sum.stroops).toBe(10_000_000_000_000_000n);
      expect(shares[0].amount).toMatch(/^\d+\.\d{7}$/);
    });

    it("handles total amount equal to 1 stroop (0.0000001) among 5 people", () => {
      const members = generateMembers(5, false);
      const oneStroop = Money.parse("0.0000001");

      const shares = calculateAllShares(oneStroop, members, "equal");
      const sum = Money.sum(shares.map((s) => s.amount));

      expect(sum.stroops).toBe(1n);
      // Exactly 1 member gets 1 stroop, other 4 get 0
      const positiveShares = shares.filter((s) => s.amount === "0.0000001");
      const zeroShares = shares.filter((s) => s.amount === "0.0000000");

      expect(positiveShares).toHaveLength(1);
      expect(zeroShares).toHaveLength(4);
    });

    it("handles all weights equal to 0 by falling back to equal split", () => {
      const members: Member[] = [
        { id: "m-1", name: "A", weight: 0 },
        { id: "m-2", name: "B", weight: 0 },
      ];
      const total = Money.parse("10.0000000");

      const shares = calculateAllShares(total, members, "custom");
      expect(shares[0].amount).toBe("5.0000000");
      expect(shares[1].amount).toBe("5.0000000");
    });
  });
});
