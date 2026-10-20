/**
 * Budget arithmetic (issue #320). Display-only: nothing here settles, and
 * settlement amounts are never altered.
 *
 * The invariant this module protects is the one in lib/settlement/expenseAsset.ts:
 * amounts in different settlement assets are never summed as if they were one.
 * Spend is first totalled per settlement asset, then each asset total is
 * converted to the budget's display currency only when a rate exists. An asset
 * with no rate (e.g. USDC against an INR budget) is reported separately as
 * unconverted instead of being dropped or added at par.
 *
 * Where the expense was entered in the budget's own currency, its frozen
 * creation-time snapshot (totalAmount / exchangeRate) is used, which is exact.
 * Anything converted at today's rate is flagged approximate.
 */

import type { Expense } from "@/types/expense";
import type { ExpenseDraft } from "@/types/recurring";
import type { BudgetScope, TripBudget } from "@/types/budget";
import { UNCATEGORIZED } from "@/lib/expense/categories";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { NATIVE_ASSET_KEY } from "@/lib/stellar/assets";

/** Display-currency units per 1 XLM, from the FX service, or null when unavailable. */
export interface DisplayRate {
  /** e.g. 0.11 USD per XLM. */
  perXlm: number;
  fetchedAt: string;
  stale: boolean;
}

export interface SpendLine {
  /** Amount in the display currency. */
  amount: number;
  /** True when part of it came from today's FX rate rather than a frozen snapshot. */
  approximate: boolean;
}

export interface BudgetSummary {
  currency: string;
  committed: SpendLine;
  pending: SpendLine & { unpricedDrafts: number };
  /** null when no overall budget is set. */
  remaining: number | null;
  total: number | null;
  /** Per-scope committed spend vs cap, only for scopes with a cap. */
  caps: Array<{ scope: BudgetScope; cap: number; spent: number; percent: number }>;
  /** Settlement-asset totals that could not be converted, kept in their own asset. */
  unconverted: Array<{ asset: string; amount: number }>;
  approximate: boolean;
}

function decimal(value: string | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

const isXlm = (currency: string) => currency.toUpperCase() === "XLM";

/**
 * One expense's committed amount in the display currency, or null when it
 * cannot be converted (non-native asset without a rate).
 */
function expenseInDisplay(
  expense: Expense,
  currency: string,
  rate: DisplayRate | null,
): { amount: number; approximate: boolean } | null {
  const asset = settlementAssetOf(expense);
  const settled = decimal(expense.totalAmount);
  if (asset !== NATIVE_ASSET_KEY) return null;
  if (isXlm(currency)) return { amount: settled, approximate: false };

  // Entered in the budget currency: the agreed fiat amount is exact.
  const snapshot = decimal(expense.exchangeRate);
  if (expense.currency.toUpperCase() === currency.toUpperCase() && snapshot > 0) {
    return { amount: settled / snapshot, approximate: false };
  }
  if (!rate) return null;
  return { amount: settled * rate.perXlm, approximate: true };
}

function draftInDisplay(draft: ExpenseDraft, currency: string, rate: DisplayRate | null) {
  const amount = decimal(draft.payload.amount);
  if (!draft.payload.amount || amount <= 0) return null;
  const from = draft.payload.currency;
  if (from.toUpperCase() === currency.toUpperCase()) return { amount, approximate: false };
  if (isXlm(from) && rate) return { amount: amount * rate.perXlm, approximate: true };
  // A draft in some other fiat currency is converted (and frozen) only when
  // it is reviewed and saved; until then it is counted as unpriced.
  return null;
}

export function summarizeBudget(
  budget: TripBudget,
  expenses: Expense[],
  drafts: ExpenseDraft[],
  rate: DisplayRate | null,
): BudgetSummary {
  const committed: SpendLine = { amount: 0, approximate: false };
  const byScope = new Map<string, number>();
  const unconverted = new Map<string, number>();

  for (const expense of expenses) {
    const converted = expenseInDisplay(expense, budget.currency, rate);
    if (!converted) {
      const asset = settlementAssetOf(expense);
      unconverted.set(asset, (unconverted.get(asset) ?? 0) + decimal(expense.totalAmount));
      continue;
    }
    committed.amount += converted.amount;
    committed.approximate ||= converted.approximate;
    const scope = expense.category ?? UNCATEGORIZED;
    byScope.set(scope, (byScope.get(scope) ?? 0) + converted.amount);
  }

  const pending = { amount: 0, approximate: false, unpricedDrafts: 0 };
  for (const draft of drafts) {
    if (draft.status !== "pending") continue;
    const converted = draftInDisplay(draft, budget.currency, rate);
    if (!converted) {
      pending.unpricedDrafts += 1;
      continue;
    }
    pending.amount += converted.amount;
    pending.approximate ||= converted.approximate;
  }

  const total = budget.totalAmount ? decimal(budget.totalAmount) : null;
  const caps: BudgetSummary["caps"] = [];
  if (total !== null && total > 0) {
    caps.push({ scope: "total", cap: total, spent: committed.amount, percent: (committed.amount / total) * 100 });
  }
  for (const [scope, capRaw] of Object.entries(budget.categoryCaps)) {
    const cap = decimal(capRaw);
    if (cap <= 0) continue;
    const spent = byScope.get(scope) ?? 0;
    caps.push({ scope: scope as BudgetScope, cap, spent, percent: (spent / cap) * 100 });
  }

  return {
    currency: budget.currency,
    committed,
    pending,
    total,
    remaining: total === null ? null : total - committed.amount - pending.amount,
    caps,
    unconverted: [...unconverted.entries()].map(([asset, amount]) => ({ asset, amount })),
    approximate: committed.approximate || pending.approximate,
  };
}

/** Thresholds currently crossed, per scope — the input to alert firing. */
export function crossedThresholds(summary: BudgetSummary, thresholds: number[]) {
  return summary.caps.flatMap((cap) =>
    thresholds.filter((t) => cap.percent >= t).map((threshold) => ({ scope: cap.scope, threshold, spent: cap.spent })),
  );
}

/**
 * Which alerts to fire and which to re-arm. An alert fires once when a
 * threshold is crossed; if spend later drops back below (an expense deleted),
 * the alert is cleared so a future crossing fires again.
 */
export function planAlertChanges(
  crossed: Array<{ scope: BudgetScope; threshold: number; spent: number }>,
  active: Array<{ id: string; scope: BudgetScope; threshold: number }>,
) {
  const key = (s: string, t: number) => `${s}:${t}`;
  const activeKeys = new Set(active.map((a) => key(a.scope, a.threshold)));
  const crossedKeys = new Set(crossed.map((c) => key(c.scope, c.threshold)));
  return {
    fire: crossed.filter((c) => !activeKeys.has(key(c.scope, c.threshold))),
    clear: active.filter((a) => !crossedKeys.has(key(a.scope, a.threshold))).map((a) => a.id),
  };
}

export function formatDisplay(amount: number, currency: string): string {
  return `${amount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${currency}`;
}
