import { Money } from "@/lib/money";

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
}

export interface NetPayment {
  from: string;
  to: string;
  amount: string;
  asset: string;
  fromWallet?: string;
  toWallet?: string;
  settledDebts: RawDebt[];
}

export function computeNetPayments(debts: RawDebt[]): NetPayment[] {
  const grouped = new Map<string, RawDebt[]>();

  for (const debt of debts) {
    const key = `${debt.fromId}_${debt.toId}_${debt.asset}`;
    const group = grouped.get(key) ?? [];
    group.push(debt);
    grouped.set(key, group);
  }

  const result: NetPayment[] = [];
  grouped.forEach((debtsInGroup) => {
    let totalMoney = Money.zero();
    for (const d of debtsInGroup) {
      totalMoney = totalMoney.plus(d.amount);
    }

    if (totalMoney.isPositive()) {
      const first = debtsInGroup[0];
      result.push({
        from: first.from,
        to: first.to,
        amount: totalMoney.format(7),
        asset: first.asset,
        fromWallet: first.fromWallet,
        toWallet: first.toWallet,
        settledDebts: debtsInGroup,
      });
    }
  });

  return result;
}
