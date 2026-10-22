"use client";

import { useState } from "react";
import { CheckCircle2, RotateCw } from "lucide-react";
import type { Expense, Member } from "@/types/expense";
import {
  choreCompletedThisPeriod,
  currentChoreAssignee,
  type ChoreCadence,
  type RecurringChore,
} from "@/types/workspace";
import { useToast } from "@/components/ui/Toast";

interface ChorePanelProps {
  chores: RecurringChore[];
  enabled: boolean;
  optedOut: boolean;
  optedOutMemberIds: string[];
  isOwner: boolean;
  members: Member[];
  expenses: Expense[];
  currentUserWallet?: string | null;
  onAdd: (input: {
    title: string;
    cadence: ChoreCadence;
    rotationMemberIds: string[];
    linkedExpenseId?: string | null;
  }) => Promise<unknown>;
  onComplete: (choreId: string) => Promise<void>;
  onToggleOptOut: () => Promise<void>;
  onSetEnabled: (enabled: boolean) => Promise<void>;
}

const CADENCES: Array<{ value: ChoreCadence; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "monthly", label: "Monthly" },
];

export function ChorePanel({
  chores,
  enabled,
  optedOut,
  optedOutMemberIds,
  isOwner,
  members,
  expenses,
  currentUserWallet,
  onAdd,
  onComplete,
  onToggleOptOut,
  onSetEnabled,
}: ChorePanelProps) {
  const [title, setTitle] = useState("");
  const [cadence, setCadence] = useState<ChoreCadence>("weekly");
  const [rotationMemberIds, setRotationMemberIds] = useState<string[]>([]);
  const [linkedExpenseId, setLinkedExpenseId] = useState("");
  const [saving, setSaving] = useState(false);
  const { error: toastError } = useToast();

  const normalizedWallet = currentUserWallet?.trim().toUpperCase();
  const rotationMembers = members.filter(
    (member) => member.walletAddress && !optedOutMemberIds.includes(member.id),
  );
  const getMember = (id: string) => members.find((member) => member.id === id)?.name ?? "Former member";

  const handleAdd = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || rotationMemberIds.length === 0) return;
    setSaving(true);
    try {
      await onAdd({
        title: title.trim(),
        cadence,
        rotationMemberIds,
        linkedExpenseId: linkedExpenseId || null,
      });
      setTitle("");
      setLinkedExpenseId("");
    } catch (error) {
      toastError("Could not add chore", error instanceof Error ? error.message : "Try again.");
    } finally {
      setSaving(false);
    }
  };

  const handlePreference = async (action: () => Promise<void>, success: string) => {
    try {
      await action();
    } catch (error) {
      toastError(success, error instanceof Error ? error.message : "Try again.");
    }
  };

  if (!enabled) {
    return (
      <section className="rounded-2xl border border-[#EBEBEB] bg-white p-5">
        <h2 className="text-sm font-bold text-[#0F0F14]">Chore coordination is off</h2>
        <p className="mt-1 text-xs text-[#777]">The trip owner can turn this optional pilot module back on.</p>
        {isOwner && (
          <button
            type="button"
            onClick={() => void handlePreference(() => onSetEnabled(true), "Could not enable chores")}
            className="mt-3 rounded-xl bg-[#2DD4BF] px-3 py-2 text-xs font-bold text-[#0F0F14]"
          >
            Enable chore coordination
          </button>
        )}
      </section>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-2xl border border-[#EBEBEB] bg-white p-4">
        <div>
          <h2 className="text-sm font-bold text-[#0F0F14]">Recurring chores</h2>
          <p className="mt-1 text-xs text-[#777]">
            Rotate responsibilities and keep a completion history. Chores never affect trip balances.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {normalizedWallet && (
            <button
              type="button"
              onClick={() => void handlePreference(onToggleOptOut, "Could not update preference")}
              className="rounded-xl border border-[#DDD] px-3 py-2 text-xs font-semibold text-[#555]"
            >
              {optedOut ? "Opt back in" : "Opt out"}
            </button>
          )}
          {isOwner && (
            <button
              type="button"
              onClick={() => void handlePreference(() => onSetEnabled(false), "Could not disable chores")}
              className="rounded-xl border border-[#DDD] px-3 py-2 text-xs font-semibold text-[#555]"
            >
              Turn off for trip
            </button>
          )}
        </div>
      </div>

      {optedOut && (
        <p role="status" className="rounded-xl bg-amber-50 p-3 text-xs text-amber-900">
          You have opted out. Chores remain visible, but you cannot complete them.
        </p>
      )}

      {isOwner && !optedOut && (
        <form onSubmit={handleAdd} className="space-y-3 rounded-2xl border border-[#EBEBEB] bg-white p-4">
          <label className="block text-xs font-semibold text-[#555]">
            Chore name
            <input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={120}
              required
              placeholder="Take out the bins"
              className="mt-1 w-full rounded-xl border border-[#DDD] px-3 py-2 text-sm"
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <label className="text-xs font-semibold text-[#555]">
              Repeat
              <select
                value={cadence}
                onChange={(event) => setCadence(event.target.value as ChoreCadence)}
                className="mt-1 block w-full rounded-xl border border-[#DDD] bg-white px-3 py-2"
              >
                {CADENCES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
              </select>
            </label>
            <label className="text-xs font-semibold text-[#555]">
              Optional supply expense
              <select
                value={linkedExpenseId}
                onChange={(event) => setLinkedExpenseId(event.target.value)}
                className="mt-1 block w-full rounded-xl border border-[#DDD] bg-white px-3 py-2"
              >
                <option value="">No linked expense</option>
                {expenses.map((expense) => (
                  <option key={expense.id} value={expense.id}>{expense.title}</option>
                ))}
              </select>
            </label>
          </div>
          <fieldset>
            <legend className="mb-2 text-xs font-semibold text-[#555]">Rotation order</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-2">
              {rotationMembers.map((member) => (
                <label key={member.id} className="flex items-center gap-2 text-xs text-[#555]">
                  <input
                    type="checkbox"
                    checked={rotationMemberIds.includes(member.id)}
                    onChange={(event) => setRotationMemberIds((current) =>
                      event.target.checked
                        ? [...current, member.id]
                        : current.filter((id) => id !== member.id)
                    )}
                  />
                  {rotationMemberIds.includes(member.id)
                    ? `${rotationMemberIds.indexOf(member.id) + 1}. ${member.name}`
                    : member.name}
                </label>
              ))}
            </div>
          </fieldset>
          <button
            type="submit"
            disabled={saving || !title.trim() || rotationMemberIds.length === 0}
            className="rounded-xl bg-[#2DD4BF] px-4 py-2 text-xs font-bold text-[#0F0F14] disabled:opacity-50"
          >
            {saving ? "Adding…" : "Add recurring chore"}
          </button>
        </form>
      )}

      {chores.length === 0 ? (
        <p className="rounded-2xl border border-dashed border-[#DDD] bg-white p-6 text-center text-xs text-[#777]">
          No recurring chores yet.
        </p>
      ) : (
        <ul className="space-y-3">
          {chores.map((chore) => {
            const assignedMemberId = currentChoreAssignee(chore, optedOutMemberIds);
            const completed = choreCompletedThisPeriod(chore);
            const linkedExpense = expenses.find((expense) => expense.id === chore.linkedExpenseId);
            return (
              <li key={chore.id} className="rounded-2xl border border-[#EBEBEB] bg-white p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h3 className="text-sm font-bold text-[#0F0F14]">{chore.title}</h3>
                    <p className="mt-1 text-xs text-[#777]">
                      {chore.cadence} · Next up: {assignedMemberId ? getMember(assignedMemberId) : "No assignee"}
                    </p>
                    {linkedExpense && (
                      <p className="mt-1 text-xs text-[#555]">Supply expense: {linkedExpense.title}</p>
                    )}
                  </div>
                  <button
                    type="button"
                    disabled={!normalizedWallet || optedOut || completed || !assignedMemberId}
                    onClick={() => void handlePreference(() => onComplete(chore.id), "Could not complete chore")}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-[#DDD] px-3 py-2 text-xs font-semibold text-[#555] disabled:opacity-50"
                  >
                    <CheckCircle2 size={14} />
                    {completed ? "Done this period" : "Mark complete"}
                  </button>
                </div>
                <details className="mt-3 border-t border-[#F0F0F0] pt-3 text-xs text-[#777]">
                  <summary className="flex cursor-pointer items-center gap-1.5 font-semibold">
                    <RotateCw size={13} /> Completion history ({chore.completionHistory.length})
                  </summary>
                  {chore.completionHistory.length === 0 ? (
                    <p className="mt-2">No completions recorded.</p>
                  ) : (
                    <ol className="mt-2 space-y-1">
                      {[...chore.completionHistory].reverse().map((completion, index) => (
                        <li key={`${completion.periodKey}-${index}`}>
                          {new Date(completion.completedAt).toLocaleDateString()} · {getMember(completion.assignedMemberId)} completed
                        </li>
                      ))}
                    </ol>
                  )}
                </details>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
