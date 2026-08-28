/**
 * Property-Based Test Suite & Benchmark for Seam S5: Multi-Party Debt Simplification (Issue #150 / Issue #48).
 *
 * Tests:
 * 1. Conservation of net balances for all participants across randomly generated graphs.
 * 2. Complete asset isolation across mixed-asset debts (no cross-asset netting).
 * 3. Exact determinism (permutation invariance of input debt array).
 * 4. Mutual debt cancellation (A->B 10, B->A 6 => A->B 4).
 * 5. Cycle collapse (A->B->C->A => 0 transfers).
 * 6. Partial settlement safety (paid debts are excluded and never produce transfers).
 * 7. Benchmark: 50 participants, 500 debts graph simplification performance.
 */

import {
  computeNetPayments,
  simplifyDebts,
  computeNetBalances,
  type RawDebt,
  type NetPayment,
} from "@/lib/settlement/simplify";
import { Money } from "@/lib/money";

// ── Pseudo-Random Graph Generator for Property Tests ─────────────────────────

function createPRNG(seed = 9999) {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const random = createPRNG(42);

function randomInt(min: number, max: number): number {
  return Math.floor(random() * (max - min + 1)) + min;
}

function randomAmount(): string {
  const whole = randomInt(1, 100);
  const frac = randomInt(0, 9999999).toString().padStart(7, "0");
  return `${whole}.${frac}`;
}

function shuffle<T>(array: T[]): T[] {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function generateRandomGraph(opts: {
  participantCount: number;
  debtCount: number;
  assets?: string[];
  partialSettledRatio?: number;
}): RawDebt[] {
  const {
    participantCount,
    debtCount,
    assets = ["native"],
    partialSettledRatio = 0,
  } = opts;

  const debts: RawDebt[] = [];

  for (let i = 0; i < debtCount; i++) {
    const fromIdx = randomInt(1, participantCount);
    let toIdx = randomInt(1, participantCount);
    while (toIdx === fromIdx) {
      toIdx = randomInt(1, participantCount);
    }

    const asset = assets[randomInt(0, assets.length - 1)];
    const isPaid = partialSettledRatio > 0 && random() < partialSettledRatio;

    debts.push({
      expenseId: `exp-${i}`,
      fromId: `user-${fromIdx}`,
      toId: `user-${toIdx}`,
      from: `Participant ${fromIdx}`,
      to: `Participant ${toIdx}`,
      fromWallet: `G_WALLET_${fromIdx}`,
      toWallet: `G_WALLET_${toIdx}`,
      amount: randomAmount(),
      asset,
      paid: isPaid,
    });
  }

  return debts;
}

/**
 * Computes net balances map from an array of payments or raw debts for validation.
 */
function getNetBalancesMap(
  transfers: Array<{ fromId?: string; toId?: string; from: string; to: string; amount: string | number | Money; asset: string; paid?: boolean }>,
): Map<string, Map<string, Money>> {
  const assetMap = new Map<string, Map<string, Money>>();

  for (const t of transfers) {
    if (t.paid) continue;
    const amount = t.amount instanceof Money ? t.amount : Money.parse(t.amount);
    const from = t.fromId ?? t.from;
    const to = t.toId ?? t.to;

    let pMap = assetMap.get(t.asset);
    if (!pMap) {
      pMap = new Map();
      assetMap.set(t.asset, pMap);
    }

    const curFrom = pMap.get(from) ?? Money.zero();
    pMap.set(from, curFrom.minus(amount));

    const curTo = pMap.get(to) ?? Money.zero();
    pMap.set(to, curTo.plus(amount));
  }

  return assetMap;
}

describe("Seam S5: Multi-Party Debt Simplification Engine", () => {
  // ===========================================================================
  // Core Concrete Edge Cases
  // ===========================================================================
  describe("Core Concrete Behavior", () => {
    it("mutual debts cancel correctly (A owes B 10, B owes A 6 => A owes B 4)", () => {
      const debts: RawDebt[] = [
        { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: "10.0000000", asset: "native" },
        { expenseId: "2", fromId: "B", toId: "A", from: "Bob", to: "Alice", amount: "6.0000000", asset: "native" },
      ];

      const payments = simplifyDebts(debts);

      expect(payments).toHaveLength(1);
      expect(payments[0].from).toBe("Alice");
      expect(payments[0].to).toBe("Bob");
      expect(payments[0].amount).toBe("4.0000000");
    });

    it("3-way cycles collapse completely to 0 transfers (A->B 10, B->C 10, C->A 10)", () => {
      const debts: RawDebt[] = [
        { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: "10.0000000", asset: "native" },
        { expenseId: "2", fromId: "B", toId: "C", from: "Bob", to: "Charlie", amount: "10.0000000", asset: "native" },
        { expenseId: "3", fromId: "C", toId: "A", from: "Charlie", to: "Alice", amount: "10.0000000", asset: "native" },
      ];

      const payments = simplifyDebts(debts);

      expect(payments).toHaveLength(0);
    });

    it("transitive chains simplify to direct payments (A->B 10, B->C 10 => A->C 10)", () => {
      const debts: RawDebt[] = [
        { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: "10.0000000", asset: "native" },
        { expenseId: "2", fromId: "B", toId: "C", from: "Bob", to: "Charlie", amount: "10.0000000", asset: "native" },
      ];

      const payments = simplifyDebts(debts);

      expect(payments).toHaveLength(1);
      expect(payments[0].from).toBe("Alice");
      expect(payments[0].to).toBe("Charlie");
      expect(payments[0].amount).toBe("10.0000000");
    });

    it("never crosses assets between different currency debts", () => {
      const debts: RawDebt[] = [
        { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: "10.0000000", asset: "native" },
        { expenseId: "2", fromId: "B", toId: "A", from: "Bob", to: "Alice", amount: "10.0000000", asset: "USDC:GBBD..." },
      ];

      const payments = simplifyDebts(debts);

      // Must NOT net across XLM and USDC!
      expect(payments).toHaveLength(2);
      const xlmPayment = payments.find((p) => p.asset === "native");
      const usdcPayment = payments.find((p) => p.asset === "USDC:GBBD...");

      expect(xlmPayment?.from).toBe("Alice");
      expect(xlmPayment?.to).toBe("Bob");
      expect(xlmPayment?.amount).toBe("10.0000000");

      expect(usdcPayment?.from).toBe("Bob");
      expect(usdcPayment?.to).toBe("Alice");
      expect(usdcPayment?.amount).toBe("10.0000000");
    });

    it("ignores paid debts during simplification (Invariant 5)", () => {
      const debts: RawDebt[] = [
        { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: "10.0000000", asset: "native", paid: true },
        { expenseId: "2", fromId: "B", toId: "A", from: "Bob", to: "Alice", amount: "6.0000000", asset: "native", paid: false },
      ];

      const payments = simplifyDebts(debts);

      // Only unsettled debt (B owes A 6) should generate a transfer
      expect(payments).toHaveLength(1);
      expect(payments[0].from).toBe("Bob");
      expect(payments[0].to).toBe("Alice");
      expect(payments[0].amount).toBe("6.0000000");
    });
  });

  // ===========================================================================
  // Property 1: Conservation of Net Balances (Invariant 1)
  // ===========================================================================
  describe("Property 1: Strict Balance Conservation", () => {
    it("preserves exact net balance for every participant across 100 randomized graphs", () => {
      for (let trial = 0; trial < 100; trial++) {
        const participantCount = randomInt(3, 15);
        const debtCount = randomInt(5, 40);
        const debts = generateRandomGraph({
          participantCount,
          debtCount,
          assets: ["native", "USDC:GBBD..."],
          partialSettledRatio: 0.2,
        });

        const initialBalances = getNetBalancesMap(debts);
        const payments = simplifyDebts(debts);
        const finalBalances = getNetBalancesMap(payments);

        // Verify every participant's net position is unchanged in every asset
        for (const [asset, pMap] of initialBalances) {
          const finalPMap = finalBalances.get(asset) ?? new Map();

          for (const [participant, initialNet] of pMap) {
            const finalNet = finalPMap.get(participant) ?? Money.zero();
            expect(finalNet.stroops).toBe(initialNet.stroops);
          }
        }
      }
    });
  });

  // ===========================================================================
  // Property 2: Determinism & Permutation Invariance (Invariant 3)
  // ===========================================================================
  describe("Property 2: Determinism & Platform Independence", () => {
    it("produces byte-identical payments regardless of input debt ordering", () => {
      for (let trial = 0; trial < 50; trial++) {
        const debts = generateRandomGraph({
          participantCount: 8,
          debtCount: 20,
          assets: ["native", "USDC:G123"],
        });

        const canonicalResult = simplifyDebts(debts);
        const canonicalJson = JSON.stringify(canonicalResult);

        for (let p = 0; p < 5; p++) {
          const permuted = shuffle(debts);
          const permutedResult = simplifyDebts(permuted);
          const permutedJson = JSON.stringify(permutedResult);

          expect(permutedJson).toBe(canonicalJson);
        }
      }
    });
  });

  // ===========================================================================
  // Property 3: Monotonic Non-Expansion (Invariant 4)
  // ===========================================================================
  describe("Property 3: Transfer Count Non-Expansion", () => {
    it("simplified transfer count is always <= pairwise deduplicated count", () => {
      for (let trial = 0; trial < 100; trial++) {
        const debts = generateRandomGraph({
          participantCount: randomInt(4, 12),
          debtCount: randomInt(10, 30),
        });

        const simplified = simplifyDebts(debts, { mode: "simplified" });
        const pairwise = simplifyDebts(debts, { mode: "pairwise" });

        expect(simplified.length).toBeLessThanOrEqual(pairwise.length);
      }
    });
  });

  // ===========================================================================
  // Property 4: Fairness Invariants
  // ===========================================================================
  describe("Property 4: Fairness & Flow Integrity", () => {
    it("only net debtors send and only net creditors receive", () => {
      for (let trial = 0; trial < 50; trial++) {
        const debts = generateRandomGraph({
          participantCount: 10,
          debtCount: 25,
        });

        const initialBalances = getNetBalancesMap(debts).get("native") ?? new Map();
        const payments = simplifyDebts(debts);

        for (const payment of payments) {
          const senderNet = initialBalances.get(payment.fromId ?? payment.from) ?? Money.zero();
          const receiverNet = initialBalances.get(payment.toId ?? payment.to) ?? Money.zero();

          // Sender must be a net debtor (net < 0)
          expect(senderNet.isNegative()).toBe(true);
          // Receiver must be a net creditor (net > 0)
          expect(receiverNet.isPositive()).toBe(true);
        }
      }
    });
  });

  // ===========================================================================
  // Benchmark: 50 Participants, 500 Debts (Deliverable Requirement)
  // ===========================================================================
  describe("Benchmark: Large-Scale Graph (50 Participants, 500 Debts)", () => {
    it("simplifies a dense 50-participant, 500-debt graph with high performance and zero error", () => {
      const debts = generateRandomGraph({
        participantCount: 50,
        debtCount: 500,
        assets: ["native", "USDC:GA5Z64..."],
        partialSettledRatio: 0.1,
      });

      const startTime = performance.now();
      const payments = simplifyDebts(debts);
      const durationMs = performance.now() - startTime;

      // Performance check: should execute in well under 50ms
      expect(durationMs).toBeLessThan(50);

      // Verify conservation on the large graph
      const initialBalances = getNetBalancesMap(debts);
      const finalBalances = getNetBalancesMap(payments);

      for (const [asset, pMap] of initialBalances) {
        const finalPMap = finalBalances.get(asset) ?? new Map();
        for (const [participant, initialNet] of pMap) {
          const finalNet = finalPMap.get(participant) ?? Money.zero();
          expect(finalNet.stroops).toBe(initialNet.stroops);
        }
      }

      // Verify transfers count is bounded by N - 1 per asset
      expect(payments.length).toBeLessThan(50 * 2);
    });
  });
});
