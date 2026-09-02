import * as fc from "fast-check";
import { computeNetPayments, type RawDebt, type NetPayment } from "@/lib/settlement/netBalance";
import { makeRawDebtsArb } from "./generators";
import { Money } from "@/lib/money";
import { parseAssetKey, assetKey } from "@/lib/stellar/assets";

/**
 * Mirrors `normalizeAsset` in lib/settlement/simplify.ts, including its
 * fallback. On an unparseable key the engine groups by the *trimmed* string;
 * returning the raw one here made the test disagree with the engine about which
 * bucket a malformed asset like "   :GAAA…" belongs to, and read as a
 * conservation failure when nothing was actually lost.
 */
function normalizeAsset(asset: string): string {
  try {
    return assetKey(parseAssetKey(asset));
  } catch {
    return asset.trim();
  }
}

describe("Netting Property Tests", () => {
  // Helper to compute net positions in stroops to avoid float issues
  function getNetPositions(debts: RawDebt[]): Map<string, Map<string, bigint>> {
    const assetPositions = new Map<string, Map<string, bigint>>();

    for (const d of debts) {
      const asset = normalizeAsset(d.asset);
      if (!assetPositions.has(asset)) {
        assetPositions.set(asset, new Map());
      }
      const balances = assetPositions.get(asset)!;
      const amountStroops = Money.parse(d.amount).toStroops();

      balances.set(d.fromId, (balances.get(d.fromId) ?? 0n) - amountStroops);
      balances.set(d.toId, (balances.get(d.toId) ?? 0n) + amountStroops);
    }
    return assetPositions;
  }

  function getNetPositionsFromPayments(payments: NetPayment[]): Map<string, Map<string, bigint>> {
    const assetPositions = new Map<string, Map<string, bigint>>();

    for (const p of payments) {
      const asset = normalizeAsset(p.asset);
      if (!assetPositions.has(asset)) {
        assetPositions.set(asset, new Map());
      }
      const balances = assetPositions.get(asset)!;
      const amountStroops = Money.parse(p.amount).toStroops();

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
            const asset = normalizeAsset(d.asset);
            if (!inputBalances.has(asset)) {
              inputBalances.set(asset, new Map());
            }
            const bal = inputBalances.get(asset)!;
            const stroops = Money.parse(d.amount).toStroops();
            bal.set(d.from, (bal.get(d.from) ?? 0n) - stroops);
            bal.set(d.to, (bal.get(d.to) ?? 0n) + stroops);
          }

          const outputBalances = getNetPositionsFromPayments(result);

          // Assert net balances match (for non-zero balances)
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

  it("never crosses assets in netting", () => {
    fc.assert(
      fc.property(
        makeRawDebtsArb(),
        ({ debts }) => {
          const result = computeNetPayments(debts);

          result.forEach((p) => {
            expect(p.settledDebts.length).toBeGreaterThan(0);
            p.settledDebts.forEach((d) => {
              expect(normalizeAsset(d.asset)).toBe(normalizeAsset(p.asset));
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

          const inputTotalStroops = debts.reduce((s, d) => s + Money.parse(d.amount).toStroops(), 0n);
          const outputTotalStroops = result.reduce((s, p) => s + Money.parse(p.amount).toStroops(), 0n);

          expect(outputTotalStroops).toBeLessThanOrEqual(inputTotalStroops);
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
