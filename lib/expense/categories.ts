/**
 * Expense categories.
 *
 * A closed list rather than free text: categories drive filters and (later)
 * per-category budgets, and both only work when "Food", "food" and "Meals"
 * cannot become three different buckets. Free-form labelling is what tags are
 * for.
 *
 * The same list is enforced by the `expenses_category_check` constraint in
 * migrations/0008_expense_categories_tags_search.sql — change both together.
 */

export const EXPENSE_CATEGORIES = [
  "food",
  "groceries",
  "lodging",
  "transport",
  "activities",
  "shopping",
  "utilities",
  "rent",
  "subscriptions",
  "health",
  "other",
] as const;

export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Filter value for expenses that have no category (every pre-#317 row). */
export const UNCATEGORIZED = "uncategorized";

export const EXPENSE_CATEGORY_LABELS: Readonly<Record<ExpenseCategory, string>> = Object.freeze({
  food: "Food & drink",
  groceries: "Groceries",
  lodging: "Lodging",
  transport: "Transport",
  activities: "Activities",
  shopping: "Shopping",
  utilities: "Utilities",
  rent: "Rent",
  subscriptions: "Subscriptions",
  health: "Health",
  other: "Other",
});

export function isExpenseCategory(value: unknown): value is ExpenseCategory {
  return typeof value === "string" && (EXPENSE_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Normalizes user or wire input to a category, or null when absent.
 * Throws on a value that is present but not a known category, so a typo is an
 * error at the boundary instead of a silently uncategorized expense.
 */
export function normalizeCategory(value: unknown): ExpenseCategory | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new Error("Category must be a string.");
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  if (!isExpenseCategory(trimmed)) {
    throw new Error(`Unknown category "${value}". Use one of: ${EXPENSE_CATEGORIES.join(", ")}.`);
  }
  return trimmed;
}

export function categoryLabel(category: string | null | undefined): string {
  if (!category) return "Uncategorized";
  return isExpenseCategory(category) ? EXPENSE_CATEGORY_LABELS[category] : category;
}
