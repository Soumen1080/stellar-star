/**
 * Seam S5 — Multi-Party Debt Simplification Engine (Issue #150 / Issue #48).
 *
 * Invariants:
 * 1. Conservation: For every participant, net balance before and after simplification is identical.
 * 2. Asset Isolation: Never cross assets (e.g. XLM and USDC are simplified in completely disjoint graphs).
 * 3. Determinism: Byte-identical output on any platform, independent of Map/Object iteration order.
 * 4. Transfer Count: Transfer count is strictly <= pairwise deduplicated transfer count.
 * 5. Partial Settlement: No transfer is generated for settled debts (paid: true).
 * 6. Termination: Guaranteed termination for arbitrary graphs (including fully connected and cycles).
 */

import { Money } from "@/lib/money";
import { parseAssetKey, assetKey } from "@/lib/stellar/assets";

export interface RawDebt {
  expenseId: string;
  fromId: string;
  toId: string;
  from: string;
  to: string;
  amount: number | string | Money;
  asset: string;
  fromWallet?: string;
  toWallet?: string;
  paid?: boolean;
}

export interface NetPayment {
  from: string;
  to: string;
  fromId?: string;
  toId?: string;
  amount: string;
  asset: string;
  fromWallet?: string;
  toWallet?: string;
  settledDebts: RawDebt[];
}

export interface SettlementOptions {
  mode?: "simplified" | "pairwise";
}

interface ParticipantInfo {
  id: string;
  name: string;
  walletAddress?: string;
}

interface BalanceEntry {
  participant: ParticipantInfo;
  balance: Money; // Positive = creditor (is owed), Negative = debtor (owes)
}

/**
 * Normalizes an asset string to a canonical asset identifier.
 */
function normalizeAsset(rawAsset: string): string {
  try {
    const parsed = parseAssetKey(rawAsset);
    return assetKey(parsed);
  } catch {
    return rawAsset.trim();
  }
}

/**
 * Computes net balances for all participants per asset.
 * Net balance = (total owed to participant) - (total participant owes).
 */
export function computeNetBalances(
  debts: RawDebt[],
): Map<string, Map<string, { info: ParticipantInfo; net: Money }>> {
  const assetMap = new Map<string, Map<string, { info: ParticipantInfo; net: Money }>>();

  for (const debt of debts) {
    if (debt.paid) continue; // Ignore already settled debts (Invariant 5)

    const debtMoney = debt.amount instanceof Money ? debt.amount : Money.parse(debt.amount);
    if (debtMoney.isZero() || debtMoney.isNegative()) continue;
    if (debt.fromId === debt.toId) continue; // Self-debts cancel automatically

    const canonicalAsset = normalizeAsset(debt.asset);
    let participants = assetMap.get(canonicalAsset);
    if (!participants) {
      participants = new Map();
      assetMap.set(canonicalAsset, participants);
    }

    // Debtor (fromId): net balance decreases
    const debtor = participants.get(debt.fromId) ?? {
      info: { id: debt.fromId, name: debt.from, walletAddress: debt.fromWallet },
      net: Money.zero(),
    };
    if (debt.fromWallet && !debtor.info.walletAddress) {
      debtor.info.walletAddress = debt.fromWallet;
    }
    debtor.net = debtor.net.minus(debtMoney);
    participants.set(debt.fromId, debtor);

    // Creditor (toId): net balance increases
    const creditor = participants.get(debt.toId) ?? {
      info: { id: debt.toId, name: debt.to, walletAddress: debt.toWallet },
      net: Money.zero(),
    };
    if (debt.toWallet && !creditor.info.walletAddress) {
      creditor.info.walletAddress = debt.toWallet;
    }
    creditor.net = creditor.net.plus(debtMoney);
    participants.set(debt.toId, creditor);
  }

  return assetMap;
}

/**
 * Simplifies debts for a single asset graph using deterministic greedy matching
 * with exact 1:1 balance cancellation.
 */
function simplifySingleAssetGraph(
  asset: string,
  participantsMap: Map<string, { info: ParticipantInfo; net: Money }>,
  rawDebts: RawDebt[],
): NetPayment[] {
  // Separate into debtors (net < 0) and creditors (net > 0)
  // Neutral participants (net == 0) are completely excluded (cycles collapsed).
  const debtors: Array<{ info: ParticipantInfo; amount: Money }> = [];
  const creditors: Array<{ info: ParticipantInfo; amount: Money }> = [];

  for (const [, entry] of participantsMap) {
    if (entry.net.isNegative()) {
      debtors.push({ info: entry.info, amount: entry.net.abs() });
    } else if (entry.net.isPositive()) {
      creditors.push({ info: entry.info, amount: entry.net });
    }
  }

  if (debtors.length === 0 || creditors.length === 0) {
    return [];
  }

  // Deterministic sorting key for stable priority matching:
  // 1. Amount DESC (settle largest amounts first)
  // 2. ID ASC (lexicographical tie-breaker for deterministic execution)
  const sortDebtors = (list: typeof debtors) => {
    list.sort((a, b) => {
      if (!a.amount.equals(b.amount)) {
        return a.amount.greaterThan(b.amount) ? -1 : 1;
      }
      return a.info.id.localeCompare(b.info.id);
    });
  };

  const sortCreditors = (list: typeof creditors) => {
    list.sort((a, b) => {
      if (!a.amount.equals(b.amount)) {
        return a.amount.greaterThan(b.amount) ? -1 : 1;
      }
      return a.info.id.localeCompare(b.info.id);
    });
  };

  sortDebtors(debtors);
  sortCreditors(creditors);

  const payments: NetPayment[] = [];

  // Group raw debts by asset for provenance lookup (sorted deterministically)
  const unsettledRawDebts = rawDebts
    .filter((d) => !d.paid && normalizeAsset(d.asset) === asset)
    .sort((a, b) => {
      const cmpExp = a.expenseId.localeCompare(b.expenseId);
      if (cmpExp !== 0) return cmpExp;
      const cmpFrom = a.fromId.localeCompare(b.fromId);
      if (cmpFrom !== 0) return cmpFrom;
      return a.toId.localeCompare(b.toId);
    });

  // ── Step 1: Exact 1:1 Match Fast-Path (Subset-Sum size 1 optimization) ──
  // If debtor D owes exactly what creditor C is owed, match them immediately
  // to eliminate 2 non-zero balances in 1 transfer.
  for (let i = 0; i < debtors.length; i++) {
    const d = debtors[i];
    if (d.amount.isZero()) continue;

    for (let j = 0; j < creditors.length; j++) {
      const c = creditors[j];
      if (c.amount.isZero()) continue;

      if (d.amount.equals(c.amount)) {
        const transferAmount = d.amount;
        const matchingDebts = unsettledRawDebts.filter(
          (rd) => rd.fromId === d.info.id || rd.toId === c.info.id,
        );

        payments.push({
          from: d.info.name,
          to: c.info.name,
          fromId: d.info.id,
          toId: c.info.id,
          amount: transferAmount.format(7),
          asset,
          fromWallet: d.info.walletAddress,
          toWallet: c.info.walletAddress,
          settledDebts: matchingDebts.length > 0 ? matchingDebts : unsettledRawDebts,
        });

        d.amount = Money.zero();
        c.amount = Money.zero();
        break;
      }
    }
  }

  // Filter out resolved entries and re-sort
  const remainingDebtors = debtors.filter((d) => d.amount.isPositive());
  const remainingCreditors = creditors.filter((c) => c.amount.isPositive());
  sortDebtors(remainingDebtors);
  sortCreditors(remainingCreditors);

  // ── Step 2: Greedy Largest-Debtor / Largest-Creditor Matching ──
  while (remainingDebtors.length > 0 && remainingCreditors.length > 0) {
    const debtor = remainingDebtors[0];
    const creditor = remainingCreditors[0];

    const transferAmount = debtor.amount.lessThanOrEqual(creditor.amount)
      ? debtor.amount
      : creditor.amount;

    const matchingDebts = unsettledRawDebts.filter(
      (rd) => rd.fromId === debtor.info.id || rd.toId === creditor.info.id,
    );

    payments.push({
      from: debtor.info.name,
      to: creditor.info.name,
      fromId: debtor.info.id,
      toId: creditor.info.id,
      amount: transferAmount.format(7),
      asset,
      fromWallet: debtor.info.walletAddress,
      toWallet: creditor.info.walletAddress,
      settledDebts: matchingDebts.length > 0 ? matchingDebts : unsettledRawDebts,
    });

    debtor.amount = debtor.amount.minus(transferAmount);
    creditor.amount = creditor.amount.minus(transferAmount);

    if (debtor.amount.isZero()) {
      remainingDebtors.shift();
    } else {
      sortDebtors(remainingDebtors);
    }

    if (creditor.amount.isZero()) {
      remainingCreditors.shift();
    } else {
      sortCreditors(remainingCreditors);
    }
  }

  // Sort payments deterministically: fromId ASC, toId ASC, amount DESC
  payments.sort((a, b) => {
    const cmpFrom = (a.fromId ?? a.from).localeCompare(b.fromId ?? b.from);
    if (cmpFrom !== 0) return cmpFrom;
    const cmpTo = (a.toId ?? a.to).localeCompare(b.toId ?? b.to);
    if (cmpTo !== 0) return cmpTo;
    return b.amount.localeCompare(a.amount);
  });

  return payments;
}

/**
 * Fallback pairwise deduplication (sums debts grouped by fromId_toId_asset).
 */
function computePairwisePayments(debts: RawDebt[]): NetPayment[] {
  const grouped = new Map<string, RawDebt[]>();

  for (const debt of debts) {
    if (debt.paid) continue;
    const key = `${debt.fromId}_${debt.toId}_${normalizeAsset(debt.asset)}`;
    const group = grouped.get(key) ?? [];
    group.push(debt);
    grouped.set(key, group);
  }

  const result: NetPayment[] = [];
  const keys = Array.from(grouped.keys()).sort();

  for (const key of keys) {
    const debtsInGroup = grouped.get(key)!;
    let totalMoney = Money.zero();
    for (const d of debtsInGroup) {
      totalMoney = totalMoney.plus(d.amount);
    }

    if (totalMoney.isPositive()) {
      const first = debtsInGroup[0];
      result.push({
        from: first.from,
        to: first.to,
        fromId: first.fromId,
        toId: first.toId,
        amount: totalMoney.format(7),
        asset: first.asset,
        fromWallet: first.fromWallet,
        toWallet: first.toWallet,
        settledDebts: debtsInGroup,
      });
    }
  }

  return result;
}

/**
 * Main simplification entrypoint (Seam S5).
 *
 * Solves the group debt minimization problem deterministically while guaranteeing
 * conservation, single-asset separation, and at most (N - 1) transactions per asset.
 */
export function simplifyDebts(
  debts: RawDebt[],
  options: SettlementOptions = { mode: "simplified" },
): NetPayment[] {
  if (debts.length === 0) return [];

  if (options.mode === "pairwise") {
    return computePairwisePayments(debts);
  }

  const assetBalances = computeNetBalances(debts);
  const result: NetPayment[] = [];

  // Deterministically sort asset keys
  const sortedAssets = Array.from(assetBalances.keys()).sort();

  for (const asset of sortedAssets) {
    const participantsMap = assetBalances.get(asset)!;
    const simplified = simplifySingleAssetGraph(asset, participantsMap, debts);
    result.push(...simplified);
  }

  return result;
}

/**
 * Computes net payments across all debts.
 * Defaults to full debt simplification.
 */
export function computeNetPayments(
  debts: RawDebt[],
  options: SettlementOptions = { mode: "simplified" },
): NetPayment[] {
  return simplifyDebts(debts, options);
}
