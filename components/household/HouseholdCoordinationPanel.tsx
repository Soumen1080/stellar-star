"use client";

import { useState } from "react";
import { useLocale } from "@/context/LocaleContext";
import { useHouseholdChores } from "@/hooks/useHouseholdChores";
import { nextChoreAssignee } from "@/lib/household/rotation";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import { ChoreForm } from "./ChoreForm";
import { ChoreHistory } from "./ChoreHistory";
import { ChoreTaskCard } from "./ChoreTaskCard";

interface HouseholdCoordinationPanelProps {
  trip: Trip;
  expenses: Expense[];
  currentWallet: string | null | undefined;
  isOwner: boolean;
  onToggleModule: (enabled: boolean) => Promise<void>;
}

export function HouseholdCoordinationPanel({
  trip,
  expenses,
  currentWallet,
  isOwner,
  onToggleModule,
}: HouseholdCoordinationPanelProps) {
  const { t } = useLocale();
  const enabled = trip.householdCoordinationEnabled === true;
  const {
    chores,
    completions,
    preferences,
    myPreference,
    isLoading,
    isMutating,
    error,
    createChore,
    completeChore,
    archiveChore,
    setOptOut,
  } = useHouseholdChores(trip.id, currentWallet, enabled);
  const [showCreate, setShowCreate] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);
  const optedOut = myPreference?.optedOut ?? false;
  const optedOutWallets = preferences
    .filter((preference) => preference.optedOut)
    .map((preference) => preference.walletAddress);
  const rosterWallets = trip.members
    .map((member) => member.walletAddress?.trim())
    .filter((wallet): wallet is string => Boolean(wallet));
  const memberNames = new Map(
    trip.members
      .filter((member) => member.walletAddress)
      .map((member) => [member.walletAddress!.toUpperCase(), member.name]),
  );
  const expenseNames = new Map(expenses.map((expense) => [expense.id, expense.title]));
  const activeChores = chores.filter((chore) => chore.active);

  const toggleModule = async () => {
    setToggleError(null);
    try {
      await onToggleModule(!enabled);
    } catch (caught) {
      setToggleError(caught instanceof Error ? caught.message : "Could not update the module setting.");
    }
  };

  return (
    <section aria-labelledby="household-coordination-title" className="space-y-5">
      <header className="rounded-2xl border border-[#E5E5E5] bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <h2 id="household-coordination-title" className="text-xl font-bold text-[#0F0F14]">
              {t("household.title")}
            </h2>
            <p className="mt-2 text-sm text-[#666]">{t("household.intro")}</p>
            <p className="mt-2 text-xs leading-5 text-[#777]">{t("household.pilotNotice")}</p>
          </div>
          {isOwner && (
            <button
              type="button"
              onClick={() => void toggleModule()}
              disabled={isMutating}
              className={`rounded-lg px-4 py-2 text-sm font-semibold disabled:opacity-50 ${
                enabled ? "border border-[#D9D9D9] text-[#555]" : "bg-[#0F0F14] text-white"
              }`}
            >
              {t(enabled ? "household.disable" : "household.enable")}
            </button>
          )}
        </div>
        {toggleError && <p role="alert" className="mt-3 text-sm text-red-700">{toggleError}</p>}
      </header>

      {!enabled ? (
        <p className="rounded-xl border border-dashed border-[#D9D9D9] px-4 py-5 text-sm text-[#777]">
          {t("household.disabled")}
        </p>
      ) : (
        <>
          {error && <p role="alert" className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-800">{error}</p>}
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-[#0F0F14]">
                {optedOut ? t("household.optedOutNotice") : t("household.rotation")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => void setOptOut(!optedOut)}
              disabled={isLoading || isMutating}
              aria-pressed={optedOut}
              className="rounded-lg border border-[#D9D9D9] bg-white px-3 py-2 text-sm font-medium text-[#333] disabled:opacity-50"
            >
              {t(optedOut ? "household.optIn" : "household.optOut")}
            </button>
          </div>

          {!optedOut && (
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => setShowCreate((visible) => !visible)}
                className="rounded-lg bg-[#0F0F14] px-4 py-2 text-sm font-semibold text-white"
              >
                {t("household.add")}
              </button>
            </div>
          )}
          {showCreate && !optedOut && (
            <ChoreForm
              members={trip.members}
              optedOutWallets={optedOutWallets}
              disabled={isMutating}
              onCreate={async (draft) => {
                const created = await createChore(draft);
                if (created) setShowCreate(false);
                return created;
              }}
            />
          )}

          {isLoading ? (
            <p role="status" className="py-4 text-sm text-[#777]">{t("common.loading")}</p>
          ) : activeChores.length === 0 ? (
            <p className="rounded-xl border border-dashed border-[#D9D9D9] px-4 py-5 text-sm text-[#777]">
              {t("household.noChores")}
            </p>
          ) : (
            <div className="space-y-3">
              {activeChores.map((chore) => {
                const assignee = nextChoreAssignee(chore, preferences, rosterWallets);
                const ownerOrCreator = Boolean(
                  isOwner ||
                  currentWallet?.toUpperCase() === chore.createdByWallet.toUpperCase(),
                );
                return (
                  <ChoreTaskCard
                    key={chore.id}
                    chore={chore}
                    assigneeWallet={assignee?.walletAddress ?? null}
                    assigneeName={assignee
                      ? memberNames.get(assignee.walletAddress.toUpperCase()) ?? `${assignee.walletAddress.slice(0, 5)}…`
                      : t("household.noEligibleMembers")}
                    currentWallet={currentWallet}
                    canArchive={ownerOrCreator}
                    expenses={expenses}
                    disabled={isMutating || optedOut || !assignee}
                    onComplete={completeChore}
                    onArchive={archiveChore}
                  />
                );
              })}
            </div>
          )}
          <ChoreHistory
            completions={completions}
            chores={chores}
            memberNames={memberNames}
            expenseNames={expenseNames}
          />
        </>
      )}
    </section>
  );
}
