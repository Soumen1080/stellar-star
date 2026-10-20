import { crossedThresholds, planAlertChanges, summarizeBudget, type DisplayRate } from "@/lib/budget/compute";
import { syncBudgetAlerts } from "@/lib/budget/queries";
import type { Expense } from "@/types/expense";
import type { ExpenseDraft } from "@/types/recurring";
import type { TripBudget } from "@/types/budget";

const USDC = "USDC:GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

function expense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: Math.random().toString(36),
    title: "x",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [],
    shares: [],
    createdAt: "2026-10-01T00:00:00Z",
    settled: false,
    ...overrides,
  };
}

function budget(overrides: Partial<TripBudget> = {}): TripBudget {
  return {
    tripId: "t",
    currency: "XLM",
    totalAmount: "1000",
    categoryCaps: { food: "200" },
    thresholds: [50, 80, 100],
    version: 1,
    updatedAt: "",
    ...overrides,
  };
}

const draft = (amount: string, currency = "XLM", status: ExpenseDraft["status"] = "pending"): ExpenseDraft => ({
  id: amount,
  templateId: "tpl",
  templateVersion: 1,
  tripId: "t",
  occurrenceDate: "2026-10-05",
  payload: {
    title: "Rent",
    description: null,
    category: "rent",
    tags: [],
    currency,
    amount,
    amountKind: amount ? "fixed" : "variable",
    splitMode: "equal",
    paidByMemberId: "m1",
    members: [],
  },
  status,
  expenseId: null,
  createdAt: "",
  resolvedAt: null,
});

const usdRate: DisplayRate = { perXlm: 0.1, fetchedAt: "2026-10-01T00:00:00Z", stale: false };

describe("summarizeBudget", () => {
  it("reports committed, pending and remaining exactly in XLM", () => {
    const summary = summarizeBudget(
      budget(),
      [expense({ category: "food", totalAmount: "150" }), expense({ totalAmount: "50" })],
      [draft("300"), draft("999", "XLM", "saved"), draft("")],
      null,
    );
    expect(summary.committed).toEqual({ amount: 200, approximate: false });
    expect(summary.pending).toMatchObject({ amount: 300, unpricedDrafts: 1 });
    expect(summary.remaining).toBe(500);
    expect(summary.caps.find((c) => c.scope === "food")?.percent).toBe(75);
    expect(summary.approximate).toBe(false);
  });

  it("never sums a different settlement asset into the total", () => {
    const summary = summarizeBudget(
      budget(),
      [expense({ totalAmount: "100" }), expense({ totalAmount: "20", settlementAsset: USDC })],
      [],
      null,
    );
    expect(summary.committed.amount).toBe(100);
    expect(summary.unconverted).toEqual([{ asset: USDC, amount: 20 }]);
  });

  it("uses the frozen fiat snapshot when entered in the budget currency (exact)", () => {
    // 50 USD at 4 XLM/USD → 200 XLM settled.
    const summary = summarizeBudget(
      budget({ currency: "USD", totalAmount: "100", categoryCaps: {} }),
      [expense({ totalAmount: "200", currency: "USD", exchangeRate: "4" })],
      [],
      usdRate,
    );
    expect(summary.committed).toEqual({ amount: 50, approximate: false });
  });

  it("flags today's-rate conversions as approximate", () => {
    const summary = summarizeBudget(budget({ currency: "USD", categoryCaps: {} }), [expense({ totalAmount: "100" })], [], usdRate);
    expect(summary.committed.amount).toBeCloseTo(10);
    expect(summary.approximate).toBe(true);
  });

  it("keeps XLM spend unconverted when no rate is available, instead of adding it at par", () => {
    const summary = summarizeBudget(budget({ currency: "USD", categoryCaps: {} }), [expense({ totalAmount: "100" })], [], null);
    expect(summary.committed.amount).toBe(0);
    expect(summary.unconverted).toEqual([{ asset: "native", amount: 100 }]);
  });
});

describe("alerts fire once per crossing", () => {
  const summary = summarizeBudget(budget({ categoryCaps: {} }), [expense({ totalAmount: "850" })], [], null);
  const crossed = crossedThresholds(summary, [50, 80, 100]);

  it("detects crossed thresholds", () => {
    expect(crossed.map((c) => c.threshold)).toEqual([50, 80]);
  });

  it("fires only crossings without an active alert, and re-arms ones no longer crossed", () => {
    const plan = planAlertChanges(crossed, [
      { id: "a50", scope: "total", threshold: 50 },
      { id: "a100", scope: "total", threshold: 100 },
    ]);
    expect(plan.fire.map((f) => f.threshold)).toEqual([80]);
    expect(plan.clear).toEqual(["a100"]);
  });

  it("treats a concurrent duplicate insert as already fired", async () => {
    const insert = jest.fn(() => ({
      select: () => ({ maybeSingle: async () => ({ data: null, error: { code: "23505", message: "duplicate" } }) }),
    }));
    const client = { from: () => ({ insert }) } as never;
    await expect(syncBudgetAlerts("t", crossed.slice(0, 1), [], client)).resolves.toEqual([]);
    expect(insert).toHaveBeenCalledTimes(1);
  });
});
