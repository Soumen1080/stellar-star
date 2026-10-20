"use client";

import { useCallback, useId, useState, type KeyboardEvent } from "react";
import { SlidersHorizontal, X } from "lucide-react";
import { ExpenseFilters } from "@/components/expenses/ExpenseFilters";
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABELS,
  UNCATEGORIZED,
} from "@/lib/expense/categories";
import { normalizeTag } from "@/lib/expense/tags";
import { settlementAssetsOf } from "@/lib/settlement/expenseAsset";
import { NATIVE_ASSET_KEY } from "@/lib/stellar/assets";
import type { ExpenseHistoryFilters as Filters } from "@/lib/expense/historyFilters";
import type { Expense, Member } from "@/types/expense";

export interface FilterOption {
  value: string;
  label: string;
}

/** "native" → "XLM", "USDC:GA5Z…" → "USDC". */
export function assetLabel(key: string): string {
  return key === NATIVE_ASSET_KEY ? "XLM" : key.split(":")[0];
}

/**
 * Payers to offer. Wallet addresses identify a person across expenses (member
 * ids are per-expense), so they are the value when present.
 */
export function payerOptionsFrom(expenses: Expense[], members: Member[] = []): FilterOption[] {
  const options = new Map<string, string>();
  const add = (member: Member | undefined) => {
    if (!member?.name.trim()) return;
    const value = member.walletAddress?.trim() || member.id;
    if (!options.has(value)) options.set(value, member.name.trim());
  };
  members.forEach(add);
  for (const expense of expenses) {
    add(expense.members.find((member) => member.id === expense.paidByMemberId));
  }
  return [...options.entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export function tagSuggestionsFrom(expenses: Expense[], limit = 12): string[] {
  const counts = new Map<string, number>();
  for (const expense of expenses) {
    for (const tag of expense.tags ?? []) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([tag]) => tag);
}

export function assetOptionsFrom(expenses: Expense[]): string[] {
  return [...new Set([NATIVE_ASSET_KEY, ...settlementAssetsOf(expenses)])];
}

interface ExpenseHistoryFiltersProps {
  filters: Filters;
  onChange: (update: Partial<Filters>) => void;
  onReset: () => void;
  payerOptions: FilterOption[];
  assetOptions: string[];
  tagSuggestions: string[];
  /** Announced politely to screen readers whenever results change. */
  resultSummary: string;
  hasActiveFilters: boolean;
}

const controlClass =
  "min-h-10 w-full rounded-xl border border-[#E5E5E5] bg-white px-3 text-sm text-[#0F0F14] outline-none focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/15";
const labelClass = "text-xs font-semibold text-[#444] uppercase tracking-wide";

export function ExpenseHistoryFilters({
  filters,
  onChange,
  onReset,
  payerOptions,
  assetOptions,
  tagSuggestions,
  resultSummary,
  hasActiveFilters,
}: ExpenseHistoryFiltersProps) {
  const id = useId();
  const panelId = `${id}-panel`;
  const advancedCount = [
    filters.category,
    filters.payer,
    filters.asset,
    filters.from,
    filters.to,
    filters.tags.length > 0 ? "tags" : null,
  ].filter(Boolean).length;
  const [expanded, setExpanded] = useState(advancedCount > 0);
  const [tagDraft, setTagDraft] = useState("");

  // Stable identities matter: ExpenseFilters re-publishes its debounced text
  // whenever these change, which would undo an external "Clear all filters".
  const onQueryChange = useCallback((q: string) => onChange({ q }), [onChange]);
  const onStatusChange = useCallback(
    (status: Filters["status"]) => onChange({ status }),
    [onChange],
  );

  const addTag = (raw: string) => {
    const tag = normalizeTag(raw);
    setTagDraft("");
    if (!tag || filters.tags.includes(tag)) return;
    onChange({ tags: [...filters.tags, tag] });
  };
  const removeTag = (tag: string) => onChange({ tags: filters.tags.filter((t) => t !== tag) });
  const onTagKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      addTag(tagDraft);
    }
  };

  return (
    <section aria-label="Expense history filters" className="mb-4">
      <ExpenseFilters
        query={filters.q}
        status={filters.status}
        onQueryChange={onQueryChange}
        onStatusChange={onStatusChange}
      />

      <div className="flex flex-wrap items-center justify-between gap-2 -mt-1 mb-2">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={panelId}
          onClick={() => setExpanded((value) => !value)}
          className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-semibold text-[#444] hover:bg-white focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
        >
          <SlidersHorizontal aria-hidden="true" size={13} />
          More filters
          {advancedCount > 0 && (
            <span className="rounded-full bg-[#0F0F14] px-1.5 text-[10px] text-[#2DD4BF]">
              {advancedCount}
              <span className="sr-only"> active</span>
            </span>
          )}
        </button>
        {hasActiveFilters && (
          <button
            type="button"
            onClick={() => {
              setTagDraft("");
              onReset();
            }}
            className="rounded-lg px-2 py-1.5 text-xs font-semibold text-[#888] hover:text-[#0F0F14] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
          >
            Clear all filters
          </button>
        )}
      </div>

      <fieldset
        id={panelId}
        hidden={!expanded}
        className="mb-3 grid grid-cols-1 gap-3 rounded-xl border border-[#E5E5E5] bg-white p-3 sm:grid-cols-2"
      >
        <legend className="sr-only">More expense filters</legend>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-category`} className={labelClass}>Category</label>
          <select
            id={`${id}-category`}
            value={filters.category ?? ""}
            onChange={(event) => onChange({ category: event.target.value || null })}
            className={controlClass}
          >
            <option value="">All categories</option>
            {EXPENSE_CATEGORIES.map((category) => (
              <option key={category} value={category}>
                {EXPENSE_CATEGORY_LABELS[category]}
              </option>
            ))}
            <option value={UNCATEGORIZED}>Uncategorized</option>
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-payer`} className={labelClass}>Paid by</label>
          <select
            id={`${id}-payer`}
            value={filters.payer ?? ""}
            onChange={(event) => onChange({ payer: event.target.value || null })}
            className={controlClass}
          >
            <option value="">Anyone</option>
            {payerOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={`${id}-asset`} className={labelClass}>Settlement asset</label>
          <select
            id={`${id}-asset`}
            value={filters.asset ?? ""}
            onChange={(event) => onChange({ asset: event.target.value || null })}
            className={controlClass}
          >
            <option value="">All assets</option>
            {assetOptions.map((asset) => (
              <option key={asset} value={asset}>
                {assetLabel(asset)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-from`} className={labelClass}>From</label>
            <input
              id={`${id}-from`}
              type="date"
              value={filters.from ?? ""}
              max={filters.to ?? undefined}
              onChange={(event) => onChange({ from: event.target.value || null })}
              className={controlClass}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${id}-to`} className={labelClass}>To</label>
            <input
              id={`${id}-to`}
              type="date"
              value={filters.to ?? ""}
              min={filters.from ?? undefined}
              onChange={(event) => onChange({ to: event.target.value || null })}
              className={controlClass}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor={`${id}-tag`} className={labelClass}>Tags</label>
          <div className="flex gap-2">
            <input
              id={`${id}-tag`}
              type="text"
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={onTagKeyDown}
              placeholder="Type a tag and press Enter"
              aria-describedby={`${id}-tag-hint`}
              autoComplete="off"
              className={controlClass}
            />
            <button
              type="button"
              onClick={() => addTag(tagDraft)}
              disabled={!normalizeTag(tagDraft)}
              className="shrink-0 rounded-xl bg-[#0F0F14] px-3 text-xs font-bold text-[#2DD4BF] disabled:opacity-40"
            >
              Add
            </button>
          </div>
          <p id={`${id}-tag-hint`} className="text-[11px] text-[#888]">
            Expenses must carry every selected tag.
          </p>

          {filters.tags.length > 0 && (
            <ul aria-label="Selected tags" className="flex flex-wrap gap-1.5">
              {filters.tags.map((tag) => (
                <li key={tag}>
                  <button
                    type="button"
                    onClick={() => removeTag(tag)}
                    aria-label={`Remove tag filter ${tag}`}
                    className="inline-flex items-center gap-1 rounded-full bg-[#0F0F14] px-2.5 py-1 text-xs font-medium text-[#2DD4BF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
                  >
                    #{tag}
                    <X aria-hidden="true" size={11} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {tagSuggestions.some((tag) => !filters.tags.includes(tag)) && (
            <div role="group" aria-label="Suggested tags" className="flex flex-wrap gap-1.5">
              {tagSuggestions
                .filter((tag) => !filters.tags.includes(tag))
                .map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    onClick={() => addTag(tag)}
                    aria-label={`Filter by tag ${tag}`}
                    className="rounded-full border border-[#E5E5E5] px-2.5 py-1 text-xs text-[#555] hover:border-[#2DD4BF] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF]"
                  >
                    #{tag}
                  </button>
                ))}
            </div>
          )}
        </div>
      </fieldset>

      <p role="status" aria-live="polite" className="text-xs text-[#888]">
        {resultSummary}
      </p>
    </section>
  );
}
