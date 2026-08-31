/**
 * Mixed-asset settlement: amounts in different assets are never summed, and a
 * fiat display currency is never mistaken for a settlement asset.
 */

import { computeNetPayments, type RawDebt } from "@/lib/settlement/netBalance";
import {
  settlementAssetOf,
  settlementAssetsOf,
  isMixedAssetTrip,
  type ExpenseWithAsset,
} from "@/lib/settlement/expenseAsset";
import { CIRCLE_USDC_ISSUER_TESTNET, NATIVE_ASSET_KEY } from "@/lib/stellar/assets";
import { Money } from "@/lib/money";

const USDC = `USDC:${CIRCLE_USDC_ISSUER_TESTNET}`;

function expense(overrides: Partial<ExpenseWithAsset> = {}): ExpenseWithAsset {
  return {
    id: "exp-1",
    title: "Dinner",
    totalAmount: "20.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m-b",
    members: [
      { id: "m-a", name: "Ana" },
      { id: "m-b", name: "Ben" },
    ],
    shares: [],
    createdAt: "2026-01-01T00:00:00Z",
    settled: false,
    ...overrides,
  } as ExpenseWithAsset;
}

function debt(over: Partial<RawDebt> = {}): RawDebt {
  return {
    expenseId: "exp-1",
    fromId: "m-a",
    toId: "m-b",
    from: "Ana",
    to: "Ben",
    amount: "10.0000000",
    asset: NATIVE_ASSET_KEY,
    ...over,
  };
}

describe("a fiat display currency is not a settlement asset", () => {
  it("reports native for a EUR-entered expense, because the amount is already XLM", () => {
    // hooks/useExpenseForm converts at creation: finalXlmAmount = amount * rate.
    // `currency` records what the user typed, not what moves on the ledger.
    expect(settlementAssetOf(expense({ currency: "EUR" }))).toBe(NATIVE_ASSET_KEY);
    expect(settlementAssetOf(expense({ currency: "USD" }))).toBe(NATIVE_ASSET_KEY);
  });

  it("treats a trip of EUR- and USD-entered expenses as single-asset", () => {
    const expenses = [
      expense({ id: "e1", currency: "EUR" }),
      expense({ id: "e2", currency: "USD" }),
      expense({ id: "e3", currency: "XLM" }),
    ];

    // All three settle in XLM. Grouping by `currency` reported "Mixed Assets".
    expect(settlementAssetsOf(expenses)).toEqual([NATIVE_ASSET_KEY]);
    expect(isMixedAssetTrip(expenses)).toBe(false);
  });

  it("is mixed only when settlement assets genuinely differ", () => {
    const expenses = [
      expense({ id: "e1", currency: "EUR" }),
      expense({ id: "e2", settlementAsset: USDC }),
    ];
    expect(isMixedAssetTrip(expenses)).toBe(true);
    expect(settlementAssetsOf(expenses)).toEqual([USDC, NATIVE_ASSET_KEY].sort());
  });

  it("canonicalises the settlement asset so spellings of XLM do not fragment", () => {
    for (const spelling of ["native", "XLM", "xlm", " ", null, undefined]) {
      expect(settlementAssetOf(expense({ settlementAsset: spelling as string }))).toBe(
        NATIVE_ASSET_KEY,
      );
    }
  });
});

describe("REGRESSION: the bug that moved the wrong value", () => {
  /**
   * deriveRawDebts used `asset: expense.currency || "XLM"`. For a EUR-entered
   * expense that produced a debt tagged asset "EUR", which:
   *   1. isolated it into its own netting graph, so offsetting XLM debts between
   *      the same two people never cancelled, and
   *   2. was handed to the payment builder as if "EUR" were a Stellar asset.
   */
  it("nets EUR-entered and XLM-entered debts together — they are the same asset", () => {
    const debts = [
      // Both already converted to XLM at creation; only the typed currency differed.
      debt({ expenseId: "eur-expense", asset: settlementAssetOf(expense({ currency: "EUR" })), amount: "30.0000000" }),
      debt({ expenseId: "xlm-expense", asset: settlementAssetOf(expense({ currency: "XLM" })), amount: "20.0000000" }),
    ];

    const payments = computeNetPayments(debts);

    expect(payments).toHaveLength(1);
    expect(payments[0].asset).toBe(NATIVE_ASSET_KEY);
    expect(payments[0].amount).toBe("50.0000000");
  });

  it("never emits a payment denominated in a fiat currency code", () => {
    const debts = [
      debt({ asset: settlementAssetOf(expense({ currency: "EUR" })) }),
      debt({ expenseId: "e2", asset: settlementAssetOf(expense({ currency: "INR" })) }),
    ];

    for (const payment of computeNetPayments(debts)) {
      expect(payment.asset).not.toMatch(/^(EUR|USD|INR|GBP|JPY)$/);
    }
  });
});

describe("amounts in different assets are never summed", () => {
  it("keeps XLM and USDC in separate payments", () => {
    const debts = [
      debt({ expenseId: "e1", asset: NATIVE_ASSET_KEY, amount: "50.0000000" }),
      debt({ expenseId: "e2", asset: USDC, amount: "20.0000000" }),
    ];

    const payments = computeNetPayments(debts);

    expect(payments).toHaveLength(2);
    const byAsset = new Map(payments.map((p) => [p.asset, p.amount]));
    expect(byAsset.get(NATIVE_ASSET_KEY)).toBe("50.0000000");
    expect(byAsset.get(USDC)).toBe("20.0000000");
    // 50 + 20 = 70 must appear nowhere.
    expect(payments.some((p) => p.amount.startsWith("70"))).toBe(false);
  });

  it("does not cancel opposing debts across assets", () => {
    // Ana owes Ben 20 USDC; Ben owes Ana 50 XLM. These are NOT settled.
    const debts = [
      debt({ expenseId: "e1", fromId: "m-a", toId: "m-b", from: "Ana", to: "Ben", asset: USDC, amount: "20.0000000" }),
      debt({ expenseId: "e2", fromId: "m-b", toId: "m-a", from: "Ben", to: "Ana", asset: NATIVE_ASSET_KEY, amount: "50.0000000" }),
    ];

    const payments = computeNetPayments(debts);

    // Both survive: netting them would require a rate nobody consented to.
    expect(payments).toHaveLength(2);
    const usdc = payments.find((p) => p.asset === USDC)!;
    const xlm = payments.find((p) => p.asset === NATIVE_ASSET_KEY)!;
    expect(usdc.fromId).toBe("m-a");
    expect(usdc.amount).toBe("20.0000000");
    expect(xlm.fromId).toBe("m-b");
    expect(xlm.amount).toBe("50.0000000");
  });

  it("every emitted payment is denominated in exactly one asset", () => {
    const debts = [
      debt({ expenseId: "e1", asset: NATIVE_ASSET_KEY, amount: "5.0000000" }),
      debt({ expenseId: "e2", asset: USDC, amount: "7.0000000" }),
      debt({ expenseId: "e3", asset: NATIVE_ASSET_KEY, amount: "3.0000000" }),
    ];

    for (const payment of computeNetPayments(debts)) {
      expect(typeof payment.asset).toBe("string");
      // A payment's constituent debts must all share its asset, otherwise the
      // amount is a sum across assets.
      for (const settled of payment.settledDebts) {
        expect(settled.asset).toBe(payment.asset);
      }
    }
  });

  it("conserves value within each asset independently", () => {
    const debts = [
      debt({ expenseId: "e1", fromId: "m-a", toId: "m-b", asset: NATIVE_ASSET_KEY, amount: "40.0000000" }),
      debt({ expenseId: "e2", fromId: "m-b", toId: "m-a", asset: NATIVE_ASSET_KEY, amount: "15.0000000" }),
      debt({ expenseId: "e3", fromId: "m-a", toId: "m-b", asset: USDC, amount: "9.0000000" }),
    ];

    const totals = new Map<string, Money>();
    for (const p of computeNetPayments(debts)) {
      totals.set(p.asset, (totals.get(p.asset) ?? Money.zero()).plus(Money.parse(p.amount)));
    }

    // XLM nets to 25; USDC stays 9. Neither leaks into the other.
    expect(totals.get(NATIVE_ASSET_KEY)!.format(7)).toBe("25.0000000");
    expect(totals.get(USDC)!.format(7)).toBe("9.0000000");
  });
});

describe("a single-asset trip behaves exactly as before", () => {
  it("produces one payment with no per-asset framing", () => {
    const debts = [
      debt({ expenseId: "e1", amount: "10.0000000" }),
      debt({ expenseId: "e2", amount: "15.0000000" }),
    ];

    const payments = computeNetPayments(debts);

    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe("25.0000000");
    expect(payments[0].asset).toBe(NATIVE_ASSET_KEY);
  });
});
