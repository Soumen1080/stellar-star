export interface RawDebt {
  expenseId: string;
  fromId: string;
  toId: string;
  from: string;
  to: string;
  amount: number;
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
    let total = 0;
    for (const d of debtsInGroup) {
      total += d.amount;
    }
    const rounded = Math.round(total * 1e7) / 1e7;
    
    if (rounded > 0.0000001) {
      const first = debtsInGroup[0];
      result.push({
        from: first.from,
        to: first.to,
        amount: rounded.toFixed(7),
        asset: first.asset,
        fromWallet: first.fromWallet,
        toWallet: first.toWallet,
        settledDebts: debtsInGroup,
      });
    }
  });

  return result;
}
