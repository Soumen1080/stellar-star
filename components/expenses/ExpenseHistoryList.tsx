"use client";

import { useMemo } from "react";
import { AnimatePresence } from "framer-motion";
import { ExpenseCard } from "@/components/expenses/ExpenseCard";
import {
  ExpenseHistoryFilters,
  assetOptionsFrom,
  payerOptionsFrom,
  tagSuggestionsFrom,
} from "@/components/expenses/ExpenseHistoryFilters";
import { Spinner } from "@/components/ui/Spinner";
import { useExpenseHistory, useHistoryUrlState } from "@/hooks/useExpenseHistory";
import { hasActiveHistoryFilters } from "@/lib/expense/historyFilters";
import type { Expense, Member } from "@/types/expense";

interface ExpenseHistoryListProps {
  /** The realtime collection in scope — offline fallback and option source. */
  expenses: Expense[];
  tripId?: string;
  /** Extra payer options, e.g. trip members who have not paid for anything yet. */
  members?: Member[];
  currentUserPublicKey?: string | null;
  onDelete?: (id: string) => void;
}

/**
 * Searchable, filterable, paginated expense history with its state in the URL.
 */
export function ExpenseHistoryList({
  expenses,
  tripId,
  members,
  currentUserPublicKey,
  onDelete,
}: ExpenseHistoryListProps) {
  const { filters, setFilters, resetFilters, ready } = useHistoryUrlState();

  // Any insert, edit or payment changes either the count or the newest
  // timestamp, which is enough to know the server page is stale.
  const refreshKey = useMemo(() => {
    let newest = "";
    for (const expense of expenses) {
      const stamp = expense.updatedAt ?? expense.createdAt;
      if (stamp > newest) newest = stamp;
    }
    return `${expenses.length}:${newest}`;
  }, [expenses]);

  const history = useExpenseHistory({
    filters,
    tripId,
    fallbackExpenses: expenses,
    enabled: ready,
    refreshKey,
  });

  const payerOptions = useMemo(() => payerOptionsFrom(expenses, members), [expenses, members]);
  const assetOptions = useMemo(() => assetOptionsFrom(expenses), [expenses]);
  const tagSuggestions = useMemo(() => tagSuggestionsFrom(expenses), [expenses]);
  const active = hasActiveHistoryFilters(filters);

  const count = history.localTotal ?? history.items.length;
  const noun = `expense${count === 1 ? "" : "s"}`;
  const resultSummary = history.loading
    ? "Searching expenses…"
    : history.localTotal !== null
      ? `${count} ${noun}${active ? " match" + (count === 1 ? "es" : "") + " these filters" : ""}.`
      : `Showing ${count} ${noun}${history.hasMore ? ", more available" : ""}.`;

  if (!ready) return null;

  return (
    <div>
      <ExpenseHistoryFilters
        filters={filters}
        onChange={setFilters}
        onReset={resetFilters}
        payerOptions={payerOptions}
        assetOptions={assetOptions}
        tagSuggestions={tagSuggestions}
        resultSummary={resultSummary}
        hasActiveFilters={active}
      />

      {history.error && history.source === "local" && (
        <p className="mb-3 rounded-xl border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
          Server search is unavailable ({history.error}). Showing matches from expenses already
          loaded on this device.
        </p>
      )}

      {history.loading && history.items.length === 0 ? (
        <div className="flex justify-center py-8">
          <Spinner size={24} className="text-[#2DD4BF]" />
        </div>
      ) : history.items.length === 0 ? (
        <p className="rounded-xl border border-[#E5E5E5] bg-white px-4 py-8 text-center text-sm text-[#888]">
          No expenses match these filters.
        </p>
      ) : (
        <div className="space-y-3" aria-busy={history.loading}>
          <AnimatePresence mode="popLayout">
            {history.items.map((expense) => (
              <ExpenseCard
                key={expense.id}
                expense={expense}
                onDelete={onDelete}
                currentUserPublicKey={currentUserPublicKey}
                tripId={tripId}
              />
            ))}
          </AnimatePresence>
        </div>
      )}

      {history.hasMore && (
        <div className="mt-4 flex justify-center">
          <button
            type="button"
            onClick={() => void history.loadMore()}
            disabled={history.loadingMore}
            className="rounded-xl border border-[#E5E5E5] bg-white px-4 py-2 text-sm font-semibold text-[#0F0F14] hover:border-[#2DD4BF] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
          >
            {history.loadingMore ? "Loading…" : "Load more expenses"}
          </button>
        </div>
      )}
    </div>
  );
}
