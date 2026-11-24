"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import type { Expense } from "@/types/expense";
import type { HouseholdChore } from "@/types/householdChore";

interface ChoreTaskCardProps {
  chore: HouseholdChore;
  assigneeName: string;
  assigneeWallet: string | null;
  currentWallet: string | null | undefined;
  canArchive: boolean;
  expenses: Expense[];
  disabled: boolean;
  onComplete: (choreId: string, dueOn: string, supplyExpenseId: string | null) => Promise<boolean>;
  onArchive: (choreId: string) => Promise<boolean>;
}

export function ChoreTaskCard({
  chore,
  assigneeName,
  assigneeWallet,
  currentWallet,
  canArchive,
  expenses,
  disabled,
  onComplete,
  onArchive,
}: ChoreTaskCardProps) {
  const { t, formatDate } = useLocale();
  const [supplyExpenseId, setSupplyExpenseId] = useState("");
  const [pending, setPending] = useState(false);
  const isAssignee = Boolean(currentWallet && assigneeWallet &&
    assigneeWallet.toUpperCase() === currentWallet.toUpperCase());
  const cadenceLabel = t(`household.${chore.cadence}`);

  const complete = async () => {
    setPending(true);
    await onComplete(chore.id, chore.nextDueOn, supplyExpenseId || null);
    setPending(false);
  };
  const archive = async () => {
    setPending(true);
    await onArchive(chore.id);
    setPending(false);
  };

  return (
    <article className="rounded-xl border border-[#E5E5E5] bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold text-[#0F0F14]">{chore.title}</h3>
          {chore.details && <p className="mt-1 whitespace-pre-wrap text-sm text-[#666]">{chore.details}</p>}
          <p className="mt-2 text-xs text-[#777]">
            {cadenceLabel} · {t("household.nextDue")}: {formatDate(`${chore.nextDueOn}T00:00:00Z`, { dateStyle: "medium", timeZone: "UTC" })}
          </p>
          <p className="mt-1 text-xs text-[#777]">
            {t("household.assignedTo", { name: assigneeName })}
          </p>
        </div>
        {canArchive && (
          <button
            type="button"
            onClick={() => void archive()}
            disabled={disabled || pending}
            className="shrink-0 text-xs font-medium text-[#777] underline hover:text-[#0F0F14] disabled:opacity-50"
          >
            {t("household.archive")}
          </button>
        )}
      </div>
      {isAssignee && (
        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <label className="sr-only" htmlFor={`supply-expense-${chore.id}`}>{t("household.supplyExpense")}</label>
          <select
            id={`supply-expense-${chore.id}`}
            value={supplyExpenseId}
            onChange={(event) => setSupplyExpenseId(event.target.value)}
            disabled={disabled || pending}
            className="min-w-0 flex-1 rounded-lg border border-[#D9D9D9] px-3 py-2 text-sm"
          >
            <option value="">{t("household.noExpenseLink")}</option>
            {expenses.map((expense) => (
              <option key={expense.id} value={expense.id}>{expense.title}</option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => void complete()}
            disabled={disabled || pending}
            className="rounded-lg bg-[#0F0F14] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50"
          >
            {t("household.complete")}
          </button>
        </div>
      )}
    </article>
  );
}
