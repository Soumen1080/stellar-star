export interface NetPayment {
  from: string;
  to: string;
  amount: string;
  fromWallet?: string;
  toWallet?: string;
}

export interface RawDebt {
  from: string;
  to: string;
  amount: number;
  fromWallet?: string;
  toWallet?: string;
}

export function computeNetPayments(debts: RawDebt[]): NetPayment[] {
  const balance = new Map<string, number>();
  const wallets = new Map<string, string>();

  debts.forEach(({ from, to, amount, fromWallet, toWallet }) => {
    balance.set(from, (balance.get(from) ?? 0) - amount);
    balance.set(to,   (balance.get(to)   ?? 0) + amount);
    if (fromWallet) wallets.set(from, fromWallet);
    if (toWallet)   wallets.set(to,   toWallet);
  });

  const creditors: Array<{ name: string; balance: number }> = [];
  const debtors:   Array<{ name: string; balance: number }> = [];

  balance.forEach((bal, name) => {
    const rounded = Math.round(bal * 1e7) / 1e7;
    if (rounded > 0.0000001)  creditors.push({ name, balance:  rounded });
    if (rounded < -0.0000001) debtors.push({   name, balance: -rounded });
  });

  creditors.sort((a, b) => b.balance - a.balance);
  debtors.sort(  (a, b) => b.balance - a.balance);

  const result: NetPayment[] = [];

  let ci = 0, di = 0;
  while (ci < creditors.length && di < debtors.length) {
    const creditor = creditors[ci];
    const debtor   = debtors[di];

    const settle = Math.min(creditor.balance, debtor.balance);
    const rounded = Math.round(settle * 1e7) / 1e7;

    if (rounded > 0.0000001) {
      result.push({
        from:       debtor.name,
        to:         creditor.name,
        amount:     rounded.toFixed(7),
        fromWallet: wallets.get(debtor.name),
        toWallet:   wallets.get(creditor.name),
      });
    }

    creditor.balance -= settle;
    debtor.balance   -= settle;

    if (creditor.balance < 0.0000001) ci++;
    if (debtor.balance   < 0.0000001) di++;
  }

  return result;
}
