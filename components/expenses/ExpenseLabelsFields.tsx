"use client";

import { useId } from "react";
import { EXPENSE_CATEGORIES, EXPENSE_CATEGORY_LABELS } from "@/lib/expense/categories";
import { MAX_TAGS_PER_EXPENSE } from "@/lib/expense/tags";

interface ExpenseLabelsFieldsProps {
  category: string;
  onCategoryChange: (value: string) => void;
  tagsInput: string;
  onTagsInputChange: (value: string) => void;
  /** Normalized preview of what will be saved. */
  tags: string[];
  error?: string;
}

const fieldClass =
  "w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-[#0F0F14] outline-none transition-all border-[#E5E5E5] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20";

/** Category and tags for an expense. Organization only — neither affects any amount. */
export function ExpenseLabelsFields({
  category,
  onCategoryChange,
  tagsInput,
  onTagsInputChange,
  tags,
  error,
}: ExpenseLabelsFieldsProps) {
  const id = useId();
  const hintId = `${id}-tags-hint`;
  const errorId = `${id}-tags-error`;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-category`} className="text-xs font-semibold text-[#444] uppercase tracking-wide">
          Category
        </label>
        <select
          id={`${id}-category`}
          value={category}
          onChange={(event) => onCategoryChange(event.target.value)}
          className={fieldClass}
        >
          <option value="">No category</option>
          {EXPENSE_CATEGORIES.map((value) => (
            <option key={value} value={value}>
              {EXPENSE_CATEGORY_LABELS[value]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-tags`} className="text-xs font-semibold text-[#444] uppercase tracking-wide">
          Tags
        </label>
        <input
          id={`${id}-tags`}
          type="text"
          value={tagsInput}
          onChange={(event) => onTagsInputChange(event.target.value)}
          placeholder="beach, day-2"
          autoComplete="off"
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          aria-invalid={error ? true : undefined}
          className={fieldClass}
        />
        <p id={hintId} className="text-[11px] text-[#888]">
          Separate with commas, up to {MAX_TAGS_PER_EXPENSE}.
          {tags.length > 0 && <> Saved as {tags.map((tag) => `#${tag}`).join(" ")}</>}
        </p>
        {error && (
          <p id={errorId} role="alert" className="text-xs text-red-500">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
