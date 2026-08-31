/**
 * lib/settlement/graph.ts
 *
 * S5 Debt Graph Simplification
 *
 * Minimizes the number of transfers to settle a debt graph while preserving
 * each participant's net position.
 */

import { Money } from "@/lib/money";
import type { RawDebt, NetPayment } from "./netBalance";

/**
 * Simplifies a list of raw debts.
 *
 * Invariants:
 * 1. Conservation: Net position of each participant before and after simplification is identical.
 * 2. Never cross assets: Debts of different assets are simplified independently.
 * 3. Deterministic: Identical input yields byte-identical output, independent of map or object iteration order.
 * 4. Transfer count: The number of simplified transfers is at most the pairwise-grouped netting result.
 * 5. No transfer is produced for a debt already settled.
 * 6. Terminates for any graph, including fully-connected ones with cycles.
 */
export function simplifyDebts(debts: RawDebt[]): NetPayment[] {
  // Filter out zero or negative debts
  const activeDebts = debts.filter((d) => {
    if (d.paid) return false;
    const m = d.amount instanceof Money ? d.amount : Money.tryParse(d.amount);
    return m ? m.isPositive() : false;
  });
  if (activeDebts.length === 0) return [];

  // Group debts by asset
  const assets = Array.from(new Set(activeDebts.map((d) => d.asset))).sort();

  const allPayments: NetPayment[] = [];

  for (const asset of assets) {
    const assetDebts = activeDebts.filter((d) => d.asset === asset);

    // Build adjacency list for undirected graph of participants in assetDebts
    const adj = new Map<string, Set<string>>();
    const memberNames = new Map<string, string>();
    const memberWallets = new Map<string, string | undefined>();

    for (const debt of assetDebts) {
      if (!adj.has(debt.fromId)) adj.set(debt.fromId, new Set());
      if (!adj.has(debt.toId)) adj.set(debt.toId, new Set());
      adj.get(debt.fromId)!.add(debt.toId);
      adj.get(debt.toId)!.add(debt.fromId);

      memberNames.set(debt.fromId, debt.from);
      memberNames.set(debt.toId, debt.to);

      if (debt.fromWallet) memberWallets.set(debt.fromId, debt.fromWallet);
      if (debt.toWallet) memberWallets.set(debt.toId, debt.toWallet);
    }

    // Find connected components
    const visited = new Set<string>();
    const components: string[][] = [];

    const sortedNodes = Array.from(adj.keys()).sort();
    for (const memberId of sortedNodes) {
      if (visited.has(memberId)) continue;

      const comp: string[] = [];
      const queue = [memberId];
      visited.add(memberId);

      while (queue.length > 0) {
        const u = queue.shift()!;
        comp.push(u);

        const neighbors = Array.from(adj.get(u)!).sort();
        for (const v of neighbors) {
          if (!visited.has(v)) {
            visited.add(v);
            queue.push(v);
          }
        }
      }
      comp.sort();
      components.push(comp);
    }

    // Sort components deterministically by their first element's ID
    components.sort((a, b) => a[0].localeCompare(b[0]));

    const assetPayments: NetPayment[] = [];

    for (const comp of components) {
      // Compute net positions in Stroops for members in this component
      const netPositions = new Map<string, bigint>();

      for (const memberId of comp) {
        netPositions.set(memberId, 0n);
      }

      // Sum debts belonging to this component using exact Money stroops
      for (const debt of assetDebts) {
        if (netPositions.has(debt.fromId) && netPositions.has(debt.toId)) {
          const debtMoney = debt.amount instanceof Money ? debt.amount : Money.parse(debt.amount);
          const amountStroops = debtMoney.toStroops();
          netPositions.set(debt.fromId, netPositions.get(debt.fromId)! - amountStroops);
          netPositions.set(debt.toId, netPositions.get(debt.toId)! + amountStroops);
        }
      }

      // Filter non-zero net positions
      const componentMembers = comp.filter((id) => (netPositions.get(id) ?? 0n) !== 0n);

      const debtors: { id: string; balance: bigint }[] = [];
      const creditors: { id: string; balance: bigint }[] = [];

      for (const id of componentMembers) {
        const bal = netPositions.get(id)!;
        if (bal < 0n) {
          debtors.push({ id, balance: bal });
        } else {
          creditors.push({ id, balance: bal });
        }
      }

      // Sort deterministically
      debtors.sort((a, b) => a.id.localeCompare(b.id));
      creditors.sort((a, b) => a.id.localeCompare(b.id));

      const debtorBalances = debtors.map((d) => ({ ...d, remaining: -d.balance }));
      const creditorBalances = creditors.map((c) => ({ ...c, remaining: c.balance }));

      let dIdx = 0;
      let cIdx = 0;

      while (dIdx < debtorBalances.length && cIdx < creditorBalances.length) {
        const debtor = debtorBalances[dIdx];
        const creditor = creditorBalances[cIdx];

        const settledAmount =
          debtor.remaining < creditor.remaining ? debtor.remaining : creditor.remaining;

        if (settledAmount > 0n) {
          const amountXlm = Money.fromStroops(settledAmount).format(7);

          assetPayments.push({
            from: memberNames.get(debtor.id) ?? debtor.id,
            to: memberNames.get(creditor.id) ?? creditor.id,
            amount: amountXlm,
            asset,
            fromWallet: memberWallets.get(debtor.id),
            toWallet: memberWallets.get(creditor.id),
            settledDebts: [],
          });

          debtor.remaining -= settledAmount;
          creditor.remaining -= settledAmount;
        }

        if (debtor.remaining === 0n) dIdx++;
        if (creditor.remaining === 0n) cIdx++;
      }
    }

    // Distribute original debts to the simplified payments in this asset
    for (const debt of assetDebts) {
      const matches = assetPayments.filter(
        (p) =>
          (debt.fromWallet && p.fromWallet === debt.fromWallet) ||
          (debt.toWallet && p.toWallet === debt.toWallet) ||
          p.from === debt.from ||
          p.to === debt.to,
      );

      const targets = matches.length > 0 ? matches : assetPayments;
      for (const p of targets) {
        p.settledDebts.push(debt);
      }
    }

    allPayments.push(...assetPayments);
  }

  return allPayments;
}
