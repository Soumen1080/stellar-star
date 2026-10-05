"use client";

import { useEffect, useState } from "react";
import { Search, X } from "lucide-react";
import { useDebouncedValue } from "@/hooks/useDebouncedValue";

export type ExpenseStatusFilter = "all" | "open" | "settled";

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
          placeholder="Search expenses or members"
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
          <option value="all">All expenses</option>
          <option value="open">Open</option>
          <option value="settled">Settled</option>
        </select>
      </label>
    </div>
  );
}
