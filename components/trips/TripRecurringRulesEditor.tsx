"use client";

import { Repeat, Trash2 } from "lucide-react";
import type { Member, SplitMode } from "@/types/expense";
import type { RecurringCadence, RecurringExpenseRule } from "@/types/trip";
import { Input } from "@/components/ui/Input";
import { CADENCE_LABELS, RECURRING_CADENCES } from "@/lib/trip/templates";

interface TripRecurringRulesEditorProps {
  rules: RecurringExpenseRule[];
  members: Member[];
  errors: Record<string, string>;
  onChange: (rules: RecurringExpenseRule[]) => void;
}

const selectClass =
  "w-full rounded-xl border border-[#E5E5E5] bg-white px-3 py-2.5 text-sm text-[#0F0F14] outline-none focus:border-[#2DD4BF]";

/**
 * Edits the common expenses a group repeats. Rules describe expenses; they
 * are never expenses themselves, so nothing here creates a debt.
 */
export function TripRecurringRulesEditor({
  rules,
  members,
  errors,
  onChange,
}: TripRecurringRulesEditorProps) {
  const namedMembers = members.filter((m) => m.name.trim());

  const update = (id: string, patch: Partial<RecurringExpenseRule>) =>
    onChange(rules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule)));

  const add = () =>
    onChange([
      ...rules,
      { id: crypto.randomUUID(), title: "", amount: "", splitMode: "equal", cadence: "per_trip" },
    ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-semibold text-[#0F0F14]">
          Recurring expenses <span className="text-[#AAA] font-normal">({rules.length})</span>
        </span>
        <button
          type="button"
          onClick={add}
          className="flex items-center gap-1 text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
        >
          <Repeat size={12} />
          Add recurring expense
        </button>
      </div>

      {rules.length === 0 && (
        <p className="text-xs text-[#AAA]">
          Optional. Common costs the group repeats, such as rent or a shared booking. Rules are
          suggestions only; they never create a balance on their own.
        </p>
      )}

      <div className="space-y-3">
        {rules.map((rule, i) => (
          <div key={rule.id} className="rounded-xl border border-[#EFEFEF] p-3 space-y-2">
            <div className="flex items-start gap-2">
              <div className="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2">
                <Input
                  aria-label={`Recurring expense ${i + 1} title`}
                  placeholder="e.g. Rent, Groceries"
                  value={rule.title}
                  onChange={(e) => update(rule.id, { title: e.target.value })}
                  error={errors[`rule_title_${i}`]}
                />
                <Input
                  aria-label={`Recurring expense ${i + 1} amount`}
                  placeholder="Amount in XLM"
                  inputMode="decimal"
                  value={rule.amount}
                  onChange={(e) => update(rule.id, { amount: e.target.value })}
                  error={errors[`rule_amount_${i}`]}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove recurring expense ${i + 1}`}
                onClick={() => onChange(rules.filter((r) => r.id !== rule.id))}
                className="mt-1 p-2 rounded-lg text-[#CCC] hover:text-red-500 hover:bg-red-50 transition-colors"
              >
                <Trash2 size={13} />
              </button>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
              <select
                aria-label={`Recurring expense ${i + 1} cadence`}
                className={selectClass}
                value={rule.cadence}
                onChange={(e) => update(rule.id, { cadence: e.target.value as RecurringCadence })}
              >
                {RECURRING_CADENCES.map((cadence) => (
                  <option key={cadence} value={cadence}>
                    {CADENCE_LABELS[cadence]}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Recurring expense ${i + 1} split`}
                className={selectClass}
                value={rule.splitMode}
                onChange={(e) => update(rule.id, { splitMode: e.target.value as SplitMode })}
              >
                <option value="equal">Split equally</option>
                <option value="custom">Split by weight</option>
              </select>
              <select
                aria-label={`Recurring expense ${i + 1} payer`}
                className={selectClass}
                value={rule.paidByMemberId ?? ""}
                onChange={(e) => update(rule.id, { paidByMemberId: e.target.value || undefined })}
              >
                <option value="">Payer chosen each time</option>
                {namedMembers.map((member) => (
                  <option key={member.id} value={member.id}>
                    Paid by {member.name}
                  </option>
                ))}
              </select>
            </div>
            {errors[`rule_payer_${i}`] && (
              <p className="text-xs text-red-500">{errors[`rule_payer_${i}`]}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
