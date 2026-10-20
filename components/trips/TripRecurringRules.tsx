"use client";

import { Plus, Repeat } from "lucide-react";
import { Money as MoneyDisplay } from "@/components/ui/Money";
import { CADENCE_LABELS } from "@/lib/trip/templates";
import type { Member } from "@/types/expense";
import type { RecurringExpenseRule } from "@/types/trip";

interface TripRecurringRulesProps {
  rules: RecurringExpenseRule[];
  members: Member[];
  /** Omitted when the viewer is not allowed to add expenses to this trip. */
  onAddFromRule?: (rule: RecurringExpenseRule) => void;
}

/**
 * The trip's common expenses. Each one is a shortcut that pre-fills the
 * expense form; a rule on its own never creates a debt.
 */
export function TripRecurringRules({ rules, members, onAddFromRule }: TripRecurringRulesProps) {
  if (rules.length === 0) return null;
  const nameOf = (id?: string) => members.find((m) => m.id === id)?.name;

  return (
    <section className="bg-white rounded-2xl border border-[#E5E5E5] p-4 mb-6">
      <h2 className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-[#888] mb-3">
        <Repeat size={12} />
        Recurring expenses
      </h2>
      <ul className="space-y-2">
        {rules.map((rule) => {
          const payer = nameOf(rule.paidByMemberId);
          return (
            <li key={rule.id} className="flex items-center gap-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold text-[#0F0F14]">{rule.title}</p>
                <p className="text-[11px] text-[#AAA]">
                  {CADENCE_LABELS[rule.cadence]}
                  {payer ? ` · usually paid by ${payer}` : ""}
                </p>
              </div>
              <span className="text-sm font-semibold text-[#555]">
                <MoneyDisplay amount={rule.amount} asset="XLM" />
              </span>
              {onAddFromRule && (
                <button
                  type="button"
                  onClick={() => onAddFromRule(rule)}
                  aria-label={`Add ${rule.title} as an expense`}
                  className="inline-flex items-center gap-1 rounded-lg border border-[#E5E5E5] px-2.5 py-1.5 text-xs font-bold text-[#0F0F14] hover:bg-[#F0F0F0]"
                >
                  <Plus size={11} />
                  Add
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
