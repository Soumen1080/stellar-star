"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";
import type { ExpenseSettlementFilter } from "@/lib/expense/historyFilters";

export type ExpenseStatusFilter = ExpenseSettlementFilter;

const STATUS_LABELS: Record<ExpenseStatusFilter, string> = {
  all: "All expenses",
  open: "Open",
  unpaid: "Unpaid",
  partial: "Partially paid",
  settled: "Settled",
};

interface ExpenseFiltersProps {
  query: string;
  status: ExpenseStatusFilter;
  onQueryChange: (value: string) => void;
  onStatusChange: (value: ExpenseStatusFilter) => void;
  delayMs?: number;
}

export function ExpenseFilters({
  query,
  status,
  onQueryChange,
  onStatusChange,
  delayMs = 300,
}: ExpenseFiltersProps) {
  const [draft, setDraft] = useState(query);
  const debouncedDraft = useDebouncedValue(draft, delayMs);

  useEffect(() => onQueryChange(debouncedDraft), [debouncedDraft, onQueryChange]);

  // Adopt a query changed from outside (URL navigation, "Clear all filters").
  // Skipped when the change is our own debounced publish, so typing that is
  // still ahead of the debounce is never overwritten.
  useEffect(() => {
    if (query !== debouncedDraft) setDraft(query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const clear = () => {
    setDraft("");
    onQueryChange("");
  };

  return (
    <div className="mb-4 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_auto]">
      <div role="search" className="relative" aria-label="Search expenses">
        <Search
          aria-hidden="true"
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-[#AAA]"
        />
        <label htmlFor="expense-search" className="sr-only">Search expenses</label>
        <input
          id="expense-search"
          type="search"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          placeholder="Search title, member, tag or tx hash"
          autoComplete="off"
          className="w-full rounded-xl border border-[#E5E5E5] bg-white py-2.5 pl-9 pr-10 text-sm text-[#0F0F14] outline-none transition-colors placeholder:text-[#AAA] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/15"
        />
        {draft && (
          <button
            type="button"
            onClick={clear}
            aria-label="Clear expense search"
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1.5 text-[#888] hover:bg-[#F0F0F0] hover:text-[#0F0F14]"
          >
            <X aria-hidden="true" size={14} />
          </button>
        )}
      </div>

      <label className="flex items-center gap-2 rounded-xl border border-[#E5E5E5] bg-white px-3 text-sm text-[#666]">
        <span className="sr-only">Expense status</span>
        <select
          value={status}
          onChange={(event) => onStatusChange(event.target.value as ExpenseStatusFilter)}
          aria-label="Expense status"
          className="min-h-10 bg-transparent text-sm font-medium text-[#0F0F14] outline-none"
        >
          {(Object.keys(STATUS_LABELS) as ExpenseStatusFilter[]).map((value) => (
            <option key={value} value={value}>
              {STATUS_LABELS[value]}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
