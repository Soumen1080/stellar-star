import type { ExpenseCategory } from "@/lib/expense/categories";

export interface TripBudget {
  tripId: string;
  /** Display currency: XLM or a fiat code. Budgets never move money. */
  currency: string;
  /** Optional overall cap, decimal string in `currency`. */
  totalAmount: string | null;
  /** Optional per-category caps. */
  categoryCaps: Partial<Record<ExpenseCategory, string>>;
  /** Percentages, ascending, e.g. [50, 80, 100]. */
  thresholds: number[];
  version: number;
  updatedAt: string;
}

/** "total" or a category key. */
export type BudgetScope = "total" | ExpenseCategory;

export interface BudgetAlert {
  id: string;
  tripId: string;
  scope: BudgetScope;
  threshold: number;
  /** Committed spend (display currency) when the threshold was crossed. */
  spentAtCrossing: string;
  firedAt: string;
}
