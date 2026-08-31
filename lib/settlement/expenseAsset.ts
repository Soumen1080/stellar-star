/**
 * Seam S1 — which asset an expense actually settles in.
 *
 * ## The distinction this module exists to enforce
 *
 * `Expense` carries two different notions that are easy to confuse, and
 * confusing them moves the wrong amount of real value:
 *
 *  - **`currency`** is the *fiat display currency the user typed in* — EUR,
 *    USD, INR. It is a presentation and provenance fact. It is **not** a
 *    Stellar asset, and no payment is ever denominated in it.
 *  - **`totalAmount` / `share.amount`** are **always already converted to the
 *    settlement asset** at expense-creation time, using `exchangeRate` (see
 *    `hooks/useExpenseForm.ts`: `finalXlmAmount = amount * rate`).
 *
 * Reading `currency` as if it were the settlement asset produces three distinct
 * failures, all of which this module prevents:
 *
 *  1. **Debts that should net do not.** The netting engine isolates assets into
 *     disjoint graphs (correctly). Tagging a EUR-entered expense as asset
 *     `"EUR"` puts it in its own graph, so a EUR-entered and a USD-entered debt
 *     between the same two people never cancel — even though both are XLM.
 *  2. **A payment is built in a nonexistent asset.** The settle button passes
 *     the debt's asset straight to the payment builder. `"EUR"` is not a
 *     Stellar asset.
 *  3. **Totals fragment.** A trip of EUR- and USD-entered expenses reads as
 *     "Mixed Assets" when every expense is denominated in one asset.
 *
 * ## What "mixed asset" legitimately means
 *
 * A trip is genuinely mixed only when expenses settle in *different Stellar
 * assets* — XLM and USDC. That is what `settlementAssetOf` reports, and it is
 * the only thing callers may sum within or refuse to sum across.
 */

import { NATIVE_ASSET_KEY, assetKey, tryParseAssetKey } from "@/lib/stellar/assets";
import type { Expense } from "@/types/expense";

/**
 * An expense that may carry an explicit settlement asset.
 *
 * The field is optional because existing rows predate it. Absent, the expense
 * settles in native XLM — which is what every historical expense did, since
 * amounts were converted to XLM on creation.
 */
export type ExpenseWithAsset = Expense & {
  /** Canonical Stellar asset key this expense settles in, e.g. "USDC:GA5Z…". */
  settlementAsset?: string | null;
};

/**
 * The canonical Stellar asset an expense settles in.
 *
 * Never returns a fiat currency code. When `settlementAsset` is absent the
 * answer is native XLM, because `totalAmount` was already converted to XLM at
 * creation time.
 */
export function settlementAssetOf(expense: ExpenseWithAsset): string {
  const declared = expense.settlementAsset;
  if (!declared) return NATIVE_ASSET_KEY;

  const trimmed = String(declared).trim();
  if (!trimmed || trimmed === "native" || trimmed.toUpperCase() === "XLM") {
    return NATIVE_ASSET_KEY;
  }

  const parsed = tryParseAssetKey(trimmed);
  return parsed ? assetKey(parsed) : trimmed;
}

/**
 * The distinct settlement assets across a set of expenses.
 *
 * Sorted, so callers render a stable order rather than one that depends on
 * expense ordering.
 */
export function settlementAssetsOf(expenses: ExpenseWithAsset[]): string[] {
  return Array.from(new Set(expenses.map(settlementAssetOf))).sort();
}

/**
 * True when these expenses settle in more than one Stellar asset.
 *
 * This — not a difference in `currency` — is what makes a trip mixed, and it is
 * the only condition under which per-asset presentation is required. A trip
 * where everything settles in XLM behaves exactly as before, whatever fiat
 * currencies were typed in.
 */
export function isMixedAssetTrip(expenses: ExpenseWithAsset[]): boolean {
  return settlementAssetsOf(expenses).length > 1;
}

/**
 * Sums amounts per settlement asset.
 *
 * The only supported way to total a mixed-asset set. There is deliberately no
 * function that returns a single scalar across assets: summing 20 USDC and
 * 50 XLM into "70" is the bug this seam exists to make unrepresentable, so the
 * type system never offers a caller that shape.
 */
export function totalsBySettlementAsset<T>(
  items: T[],
  assetOf: (item: T) => string,
  amountOf: (item: T) => string,
  add: (a: string, b: string) => string,
  zero: string,
): Map<string, string> {
  const totals = new Map<string, string>();
  for (const item of items) {
    const asset = assetOf(item);
    totals.set(asset, add(totals.get(asset) ?? zero, amountOf(item)));
  }
  return new Map([...totals.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
