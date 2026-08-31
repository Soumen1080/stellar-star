import * as fc from "fast-check";
import { simplifyDebts } from "@/lib/settlement/graph";
import { computeNetPayments, type RawDebt, type NetPayment } from "@/lib/settlement/netBalance";
import { makeRawDebtsArb } from "./generators";
import { Money } from "@/lib/money";

describe("Simplification Property Tests", () => {
  function getNetPositionsFromPayments(payments: NetPayment[]): Map<string, Map<string, bigint>> {
    const assetPositions = new Map<string, Map<string, bigint>>();

    for (const p of payments) {
      if (!assetPositions.has(p.asset)) {
        assetPositions.set(p.asset, new Map());
      }
      const balances = assetPositions.get(p.asset)!;
      const amountStroops = Money.parse(p.amount).toStroops();

      balances.set(p.from, (balances.get(p.from) ?? 0n) - amountStroops);
      balances.set(p.to, (balances.get(p.to) ?? 0n) + amountStroops);
    }
    return assetPositions;
  }

  it("conserves net positions of each participant", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb({ maxDebts: 40 }),
        ({ debts }) => {
          const simplified = simplifyDebts(debts);

          // Get net positions from input (by name)
          const inputBalances = new Map<string, Map<string, bigint>>();
          for (const d of debts) {
            if (!inputBalances.has(d.asset)) {
              inputBalances.set(d.asset, new Map());
            }
            const bal = inputBalances.get(d.asset)!;
            const stroops = Money.parse(d.amount).toStroops();
            bal.set(d.from, (bal.get(d.from) ?? 0n) - stroops);
            bal.set(d.to, (bal.get(d.to) ?? 0n) + stroops);
          }

          const outputBalances = getNetPositionsFromPayments(simplified);

          // Assert every participant's net position is identical before and after
          inputBalances.forEach((balances, asset) => {
            const outBals = outputBalances.get(asset) ?? new Map();
            balances.forEach((inBal, name) => {
              const outBal = outBals.get(name) ?? 0n;
              expect(inBal).toBe(outBal);
            });
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("never crosses assets", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb({ maxDebts: 40 }),
        ({ debts }) => {
          const simplified = simplifyDebts(debts);

          simplified.forEach((p) => {
            expect(p.settledDebts.length).toBeGreaterThan(0);
            p.settledDebts.forEach((d) => {
              expect(d.asset).toBe(p.asset);
            });
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("produces transfer count less than or equal to pairwise grouping netting", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb({ maxDebts: 45 }),
        ({ debts }) => {
          const nettingPayments = computeNetPayments(debts);
          const simplifiedPayments = simplifyDebts(debts);

          expect(simplifiedPayments.length).toBeLessThanOrEqual(nettingPayments.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  it("collapses cycles", () => {
    // A owes B 10, B owes C 10, C owes A 10 (Cycle)
    const cycleDebts: RawDebt[] = [
      { expenseId: "1", fromId: "A", toId: "B", from: "Alice", to: "Bob", amount: 10, asset: "native" },
      { expenseId: "2", fromId: "B", toId: "C", from: "Bob", to: "Charlie", amount: 10, asset: "native" },
      { expenseId: "3", fromId: "C", toId: "A", from: "Charlie", to: "Alice", amount: 10, asset: "native" },
    ];

    const result = simplifyDebts(cycleDebts);
    // Cycle should collapse completely to 0 payments
    expect(result).toHaveLength(0);
  });

  it("does not produce self-payments", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const result = simplifyDebts(debts);
          result.forEach((p) => {
            expect(p.from).not.toBe(p.to);
            if (p.fromWallet && p.toWallet) {
              expect(p.fromWallet).not.toBe(p.toWallet);
            }
          });
        }
      ),
      { numRuns: 50 }
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const res1 = simplifyDebts(debts);
          const res2 = simplifyDebts(debts);
          expect(res1).toEqual(res2);
        }
      ),
      { numRuns: 50 }
    );
  });

  it("benchmarks at 50 participants and 500 debts within sensible limits", () => {
    // Generate 50 members
    const members = Array.from({ length: 50 }, (_, i) => ({
      id: `m-${i}`,
      name: `Member ${i}`,
      walletAddress: `GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA${(i % 10).toString()}`,
    }));

    // Generate 500 random debts
    const debts: RawDebt[] = [];
    for (let i = 0; i < 500; i++) {
      const fromIdx = i % 50;
      const toIdx = (i + 13) % 50;
      debts.push({
        expenseId: `exp-${i}`,
        fromId: members[fromIdx].id,
        toId: members[toIdx].id,
        from: members[fromIdx].name,
        to: members[toIdx].name,
        amount: parseFloat((1.0 + (i % 100) * 0.1).toFixed(7)),
        asset: i % 2 === 0 ? "native" : "USDC:GBBD47IF...",
        fromWallet: members[fromIdx].walletAddress,
        toWallet: members[toIdx].walletAddress,
      });
    }

    const start = Date.now();
    const result = simplifyDebts(debts);
    const duration = Date.now() - start;

    expect(duration).toBeLessThan(100); // Must terminate in less than 100ms
    expect(result.length).toBeLessThanOrEqual(50 * 2); // max 50 transfers per asset (2 assets)
  });
});
