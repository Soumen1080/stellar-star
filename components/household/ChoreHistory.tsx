"use client";

import { useLocale } from "@/context/LocaleContext";
import type { HouseholdChore, HouseholdChoreCompletion } from "@/types/householdChore";

interface ChoreHistoryProps {
  completions: HouseholdChoreCompletion[];
  chores: HouseholdChore[];
  memberNames: Map<string, string>;
  expenseNames: Map<string, string>;
}

export function ChoreHistory({ completions, chores, memberNames, expenseNames }: ChoreHistoryProps) {
  const { t, formatDateTime } = useLocale();
  const choresById = new Map(chores.map((chore) => [chore.id, chore]));

  return (
    <section aria-labelledby="chore-history-title" className="mt-7">
      <h2 id="chore-history-title" className="mb-3 text-base font-semibold text-[#0F0F14]">
        {t("household.history")}
      </h2>
      {completions.length === 0 ? (
        <p className="rounded-xl border border-dashed border-[#D9D9D9] px-4 py-5 text-sm text-[#777]">
          {t("household.noHistory")}
        </p>
      ) : (
        <ol className="space-y-2">
          {completions.map((completion) => {
            const chore = choresById.get(completion.choreId);
            return (
              <li key={completion.id} className="rounded-lg bg-white px-4 py-3 text-sm">
                <span className="font-medium text-[#0F0F14]">{chore?.title ?? t("household.archivedChore")}</span>
                <span className="text-[#666]">
                  {" "}· {t("household.completedBy", {
                    name: memberNames.get(completion.completedByWallet.toUpperCase()) ?? `${completion.completedByWallet.slice(0, 5)}…`,
                  })}
                </span>
                <time className="mt-1 block text-xs text-[#888]" dateTime={completion.completedAt}>
                  {formatDateTime(completion.completedAt)}
                </time>
                {completion.supplyExpenseId && (
                  <p className="mt-1 text-xs text-[#666]">
                    {t("household.linkedExpense", {
                      title: expenseNames.get(completion.supplyExpenseId) ?? t("household.archivedExpense"),
                    })}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
