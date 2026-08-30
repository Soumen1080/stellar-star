import * as fc from "fast-check";
import { computeNetPayments, type RawDebt, type NetPayment } from "@/lib/settlement/netBalance";
import { makeRawDebtsArb } from "./generators";

describe("Netting Property Tests", () => {
  // Helper to compute net positions in stroops to avoid float issues
  function getNetPositions(debts: RawDebt[]): Map<string, Map<string, bigint>> {
    const assetPositions = new Map<string, Map<string, bigint>>();

    for (const d of debts) {
      if (!assetPositions.has(d.asset)) {
        assetPositions.set(d.asset, new Map());
      }
      const balances = assetPositions.get(d.asset)!;
      const amountStroops = BigInt(Math.round(d.amount * 1e7));

      balances.set(d.fromId, (balances.get(d.fromId) ?? 0n) - amountStroops);
      balances.set(d.toId, (balances.get(d.toId) ?? 0n) + amountStroops);
    }
    return assetPositions;
  }

  function getNetPositionsFromPayments(payments: NetPayment[]): Map<string, Map<string, bigint>> {
    const assetPositions = new Map<string, Map<string, bigint>>();

    for (const p of payments) {
      if (!assetPositions.has(p.asset)) {
        assetPositions.set(p.asset, new Map());
      }
      const balances = assetPositions.get(p.asset)!;
      const amountStroops = BigInt(Math.round(parseFloat(p.amount) * 1e7));

      // In NetPayment, "from" and "to" are names, but we can resolve them.
      // Wait, to compare properly, let's map by name.
      balances.set(p.from, (balances.get(p.from) ?? 0n) - amountStroops);
      balances.set(p.to, (balances.get(p.to) ?? 0n) + amountStroops);
    }
    return assetPositions;
  }

  it("conserves net positions for each participant", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const result = computeNetPayments(debts);

          // Get net positions from input (by name to match NetPayment)
          const inputBalances = new Map<string, Map<string, bigint>>();
          for (const d of debts) {
            if (!inputBalances.has(d.asset)) {
              inputBalances.set(d.asset, new Map());
            }
            const bal = inputBalances.get(d.asset)!;
            const stroops = BigInt(Math.round(d.amount * 1e7));
            bal.set(d.from, (bal.get(d.from) ?? 0n) - stroops);
            bal.set(d.to, (bal.get(d.to) ?? 0n) + stroops);
          }

          const outputBalances = getNetPositionsFromPayments(result);

          // Assert net balances match (for non-zero balances)
          inputBalances.forEach((balances, asset) => {
            const outBals = outputBalances.get(asset) ?? new Map();
            balances.forEach((inBal, name) => {
              const outBal = outBals.get(name) ?? 0n;
              expect(Number(inBal) / 1e7).toBeCloseTo(Number(outBal) / 1e7, 5);
            });
          });
        }
      ),
      { numRuns: 100 }
    );
  });

  it("never crosses assets in netting", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const result = computeNetPayments(debts);

          result.forEach((p) => {
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

  it("does not increase overall payment volume (sum of output payments <= sum of input debts)", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const result = computeNetPayments(debts);

          const inputTotalStroops = debts.reduce((s, d) => s + BigInt(Math.round(d.amount * 1e7)), 0n);
          const outputTotalStroops = result.reduce((s, p) => s + BigInt(Math.round(parseFloat(p.amount) * 1e7)), 0n);

          expect(Number(outputTotalStroops)).toBeLessThanOrEqual(Number(inputTotalStroops));
        }
      ),
      { numRuns: 100 }
    );
  });

  it("is deterministic", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const res1 = computeNetPayments(debts);
          const res2 = computeNetPayments(debts);

          expect(res1).toEqual(res2);
        }
      ),
      { numRuns: 50 }
    );
  });
});
