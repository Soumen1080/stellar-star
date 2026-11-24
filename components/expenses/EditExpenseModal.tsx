"use client";

import React, { useState, useEffect, useMemo } from "react";
import {
  X,
  Lock,
  Plus,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Users,
  Receipt,
  Scale,
  Save,
  RefreshCw,
} from "lucide-react";
import { Money } from "@/lib/money";
import {
  recomputeSharesWithSettled,
  ExpenseConflictError,
  type ConflictDetails,
} from "@/lib/expense/conflictResolver";
import { hasInstallments } from "@/lib/settlement/installments";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { ExpenseConflictModal } from "./ExpenseConflictModal";
import type { Expense, Member, SplitMode, SplitShare } from "@/types/expense";

interface EditExpenseModalProps {
  open: boolean;
  onClose: () => void;
  expense: Expense;
  currentUserPublicKey?: string | null;
  onSuccess?: (updated: Expense) => void;
}

export function EditExpenseModal({
  open,
  onClose,
  expense,
  currentUserPublicKey,
  onSuccess,
}: EditExpenseModalProps) {
  const { updateExpense } = useExpense();
  const { success: toastSuccess, error: toastError } = useToast();

  // Local editing state initialized from current expense
  const [baseExpense, setBaseExpense] = useState<Expense>(expense);
  const [title, setTitle] = useState(expense.title);
  const [description, setDescription] = useState(expense.description ?? "");
  const [totalAmount, setTotalAmount] = useState(expense.totalAmount);
  const [currency, setCurrency] = useState(expense.currency || "XLM");
  const [paidByMemberId, setPaidByMemberId] = useState(expense.paidByMemberId);
  const [splitMode, setSplitMode] = useState<SplitMode>(expense.splitMode || "equal");
  const [members, setMembers] = useState<Member[]>(expense.members);

  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState<ConflictDetails | null>(null);

  // Sync state if expense prop changes
  useEffect(() => {
    setBaseExpense(expense);
    setTitle(expense.title);
    setDescription(expense.description ?? "");
    setTotalAmount(expense.totalAmount);
    setCurrency(expense.currency || "XLM");
    setPaidByMemberId(expense.paidByMemberId);
    setSplitMode(expense.splitMode || "equal");
    setMembers(expense.members);
    setConflict(null);
  }, [expense]);

  // Settled shares are strictly immutable (Invariant 2 & 4)
  const settledShares = useMemo(() => {
    return baseExpense.shares.filter((s) => s.paid || hasInstallments(s));
  }, [baseExpense]);

  const settledTotal = useMemo(() => {
    return Money.sum(settledShares.map((s) => s.amount));
  }, [settledShares]);

  const settledMemberIds = useMemo(() => {
    return new Set(settledShares.map((s) => s.memberId));
  }, [settledShares]);

  // Exact money share recomputation
  const computedShares: SplitShare[] = useMemo(() => {
    return recomputeSharesWithSettled(
      totalAmount,
      members,
      paidByMemberId,
      splitMode,
      baseExpense.shares
    );
  }, [totalAmount, members, paidByMemberId, splitMode, baseExpense.shares]);

  // Total validation
  const validationError = useMemo(() => {
    if (!title.trim()) return "Expense title is required.";

    const parsed = Money.tryParse(totalAmount);
    if (!parsed || parsed.isZero() || parsed.isNegative()) {
      return "Total amount must be greater than zero.";
    }

    if (settledShares.length > 0 && parsed.lessThan(settledTotal)) {
      return `Total cannot be reduced below ${settledTotal.format(7)} ${currency} already settled on-chain.`;
    }

    if (members.length < 2) {
      return "An expense must have at least 2 members.";
    }

    for (const m of members) {
      if (!m.name.trim()) return "All members must have a display name.";
    }

    return null;
  }, [title, totalAmount, settledShares, settledTotal, currency, members]);

  // Handle saving updates
  const handleSave = async (updatesToApply?: Partial<Expense>) => {
    if (validationError && !updatesToApply) {
      toastError("Validation Error", validationError);
      return;
    }

    setSaving(true);
    setConflict(null);

    const proposedUpdates: Partial<Expense> = updatesToApply ?? {
      title: title.trim(),
      description: description.trim() || undefined,
      totalAmount: totalAmount.trim(),
      currency,
      paidByMemberId,
      splitMode,
      members,
      shares: computedShares,
    };

    try {
      await updateExpense(baseExpense.id, proposedUpdates);
      toastSuccess("Expense updated!", `"${proposedUpdates.title || title}" has been saved.`);
      onClose();
    } catch (err: any) {
      if (err instanceof ExpenseConflictError) {
        setConflict({
          fields: err.conflicts,
          reason: err.reason,
          serverExpense: err.serverExpense,
          proposedUpdates,
        });
      } else if (err?.code === "CONCURRENT_MODIFICATION" || err?.status === 409) {
        setConflict(err.conflict || {
          fields: ["totalAmount"],
          reason: err.message || "Concurrent modification detected.",
          serverExpense: baseExpense,
          proposedUpdates,
        });
      } else {
        toastError("Save Failed", err?.message || "Failed to update expense.");
      }
    } finally {
      setSaving(false);
    }
  };

  // Reload latest version from server
  const handleReloadLatest = (latestServerExpense: Expense) => {
    setBaseExpense(latestServerExpense);
    setTitle(latestServerExpense.title);
    setDescription(latestServerExpense.description ?? "");
    setTotalAmount(latestServerExpense.totalAmount);
    setCurrency(latestServerExpense.currency || "XLM");
    setPaidByMemberId(latestServerExpense.paidByMemberId);
    setSplitMode(latestServerExpense.splitMode || "equal");
    setMembers(latestServerExpense.members);
    setConflict(null);
    toastSuccess("Reloaded Latest Version", `Loaded version v${latestServerExpense.version ?? 1} from server.`);
  };

  // Resolve conflict and merge
  const handleResolveAndMerge = async (resolvedUpdates: Partial<Expense>) => {
    setConflict(null);
    await handleSave(resolvedUpdates);
  };

  if (!open) return null;

  // Fully settled expenses cannot be modified in place (Acceptance criteria 4)
  if (baseExpense.settled) {
    return (
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
        <div className="bg-white rounded-2xl max-w-md w-full p-6 shadow-xl space-y-4">
          <div className="flex items-center gap-2 text-amber-700">
            <Lock className="w-5 h-5" />
            <h3 className="font-bold text-base text-[#0F0F14]">Settled Expense Locked</h3>
          </div>
          <p className="text-xs text-[#666] leading-relaxed">
            &quot;{baseExpense.title}&quot; is already fully settled on-chain. Settled expenses cannot be edited in place.
            To correct an overpayment or adjustment, see the settlement corrective flow.
          </p>
          <div className="flex justify-end pt-2">
            <button
              onClick={onClose}
              className="px-4 py-2 bg-[#0F0F14] text-white text-xs font-semibold rounded-xl hover:bg-[#222]"
            >
              Close
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 overflow-y-auto">
        <div className="bg-white rounded-2xl max-w-2xl w-full p-6 sm:p-8 shadow-2xl space-y-6 my-8">
          {/* Header */}
          <div className="flex items-center justify-between border-b border-[#F0F0F0] pb-4">
            <div className="flex items-center gap-2.5">
              <span className="p-2 bg-[#0F0F14] text-[#2DD4BF] rounded-xl">
                <Receipt className="w-5 h-5" />
              </span>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-lg font-bold text-[#0F0F14]">Edit Expense</h2>
                  <span className="px-2 py-0.5 bg-[#F0F0F0] text-[#666] rounded-full text-xs font-mono">
                    v{baseExpense.version ?? 1}
                  </span>
                </div>
                <p className="text-xs text-[#666]">
                  Correct titles, amounts, payer, and split values before on-chain settlement.
                </p>
              </div>
            </div>
            <button onClick={onClose} className="text-[#888] hover:text-[#0F0F14]">
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Settled share warning banner if partially settled */}
          {settledShares.length > 0 && (
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2.5 text-xs text-amber-800">
              <Lock className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold">Partially Settled: </span>
                {settledShares.length} share(s) totaling {settledTotal.format(7)} {currency} have already settled on-chain.
                Settled shares are locked and the total cannot be reduced below this amount.
              </div>
            </div>
          )}

          {/* Form */}
          <div className="space-y-4">
            {/* Title & Total Amount */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label className="block text-xs font-semibold text-[#555] mb-1">Title</label>
                <input
                  type="text"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder="e.g. Hotel Booking"
                  className="w-full h-10 px-3 text-sm bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] text-[#0F0F14]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#555] mb-1">
                  Total ({currency})
                </label>
                <input
                  type="text"
                  value={totalAmount}
                  onChange={(e) => setTotalAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full h-10 px-3 text-sm font-mono bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] text-[#0F0F14]"
                />
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="block text-xs font-semibold text-[#555] mb-1">Description (Optional)</label>
              <textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Add context or itemization details..."
                rows={2}
                className="w-full p-3 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] text-[#0F0F14]"
              />
            </div>

            {/* Paid By (Payer) & Split Mode */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-[#555] mb-1">Paid By</label>
                <select
                  value={paidByMemberId}
                  onChange={(e) => setPaidByMemberId(e.target.value)}
                  className="w-full h-10 px-3 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl text-[#0F0F14] focus:outline-none focus:ring-2 focus:ring-[#2DD4BF]"
                >
                  {members.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name || "Unnamed Member"}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#555] mb-1">Split Mode</label>
                <div className="flex rounded-xl bg-[#F0F0F0] p-1 h-10">
                  <button
                    type="button"
                    onClick={() => setSplitMode("equal")}
                    className={`flex-1 text-xs font-semibold rounded-lg transition-all ${
                      splitMode === "equal" ? "bg-white text-[#0F0F14] shadow-sm" : "text-[#666]"
                    }`}
                  >
                    Equal Split
                  </button>
                  <button
                    type="button"
                    onClick={() => setSplitMode("custom")}
                    className={`flex-1 text-xs font-semibold rounded-lg transition-all ${
                      splitMode === "custom" ? "bg-white text-[#0F0F14] shadow-sm" : "text-[#666]"
                    }`}
                  >
                    Custom Weights
                  </button>
                </div>
              </div>
            </div>

            {/* Member List & Shares Calculation */}
            <div className="space-y-2 pt-2 border-t border-[#F0F0F0]">
              <div className="flex items-center justify-between text-xs font-semibold text-[#444]">
                <span className="flex items-center gap-1.5">
                  <Users className="w-3.5 h-3.5 text-[#666]" />
                  Participants & Recomputed Shares
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setMembers((prev) => [
                      ...prev,
                      { id: crypto.randomUUID(), name: "", walletAddress: "", weight: 1 },
                    ])
                  }
                  className="text-xs text-teal-700 hover:text-teal-900 font-semibold flex items-center gap-1"
                >
                  <Plus className="w-3.5 h-3.5" />
                  Add Member
                </button>
              </div>

              <div className="space-y-2 max-h-48 overflow-y-auto pr-1">
                {members.map((member, idx) => {
                  const isSettled = settledMemberIds.has(member.id);
                  const matchingShare = computedShares.find((s) => s.memberId === member.id);

                  return (
                    <div
                      key={member.id}
                      className={`p-2.5 rounded-xl border text-xs flex items-center justify-between gap-3 ${
                        isSettled
                          ? "bg-amber-50/50 border-amber-200 text-[#444]"
                          : "bg-[#F9F9F9] border-[#E5E5E5] text-[#0F0F14]"
                      }`}
                    >
                      <div className="flex-1 flex items-center gap-2">
                        {isSettled ? (
                          <span title="Paid Share - Locked">
                            <Lock className="w-3.5 h-3.5 text-amber-600" />
                          </span>
                        ) : (
                          <span className="text-[#888] font-mono text-[10px] w-4">{idx + 1}.</span>
                        )}

                        <input
                          type="text"
                          value={member.name}
                          disabled={isSettled}
                          onChange={(e) => {
                            const val = e.target.value;
                            setMembers((prev) =>
                              prev.map((m) => (m.id === member.id ? { ...m, name: val } : m))
                            );
                          }}
                          placeholder="Member Name"
                          className="h-8 px-2 text-xs bg-white border border-[#E0E0E0] rounded-lg w-32 focus:outline-none focus:ring-1 focus:ring-[#2DD4BF]"
                        />

                        {splitMode === "custom" && (
                          <div className="flex items-center gap-1 text-[11px] text-[#666]">
                            <span>Weight:</span>
                            <input
                              type="number"
                              min="0"
                              step="1"
                              value={member.weight ?? 1}
                              disabled={isSettled}
                              onChange={(e) => {
                                const w = parseFloat(e.target.value) || 0;
                                setMembers((prev) =>
                                  prev.map((m) => (m.id === member.id ? { ...m, weight: w } : m))
                                );
                              }}
                              className="h-8 w-14 px-1.5 text-center text-xs bg-white border border-[#E0E0E0] rounded-lg"
                            />
                          </div>
                        )}
                      </div>

                      <div className="flex items-center gap-3">
                        <span className="font-mono font-semibold text-xs text-[#0F0F14]">
                          {member.id === paidByMemberId ? (
                            <span className="text-emerald-700 font-medium">Payer (No Debt)</span>
                          ) : (
                            `${matchingShare?.amount ?? "0.00"} ${currency}`
                          )}
                        </span>

                        {!isSettled && members.length > 2 && (
                          <button
                            type="button"
                            onClick={() =>
                              setMembers((prev) => prev.filter((m) => m.id !== member.id))
                            }
                            className="text-[#888] hover:text-rose-600 p-1 rounded"
                            title="Remove Member"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Validation Error Message */}
            {validationError && (
              <p className="text-xs text-rose-600 font-medium flex items-center gap-1.5 pt-1">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                {validationError}
              </p>
            )}
          </div>

          {/* Footer Actions */}
          <div className="flex items-center justify-between pt-4 border-t border-[#F0F0F0]">
            <span className="text-xs text-[#888] font-mono">
              OCC Lock: v{baseExpense.version ?? 1}
            </span>

            <div className="flex items-center gap-2.5">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-xs font-semibold text-[#666] hover:text-[#0F0F14] transition-colors"
              >
                Cancel
              </button>

              <button
                type="button"
                disabled={saving || !!validationError}
                onClick={() => handleSave()}
                className="px-5 py-2.5 bg-[#0F0F14] hover:bg-[#222] text-white text-xs font-bold rounded-xl transition-all disabled:opacity-50 flex items-center gap-1.5"
              >
                {saving ? (
                  <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  <Save className="w-3.5 h-3.5 text-[#2DD4BF]" />
                )}
                Save Changes
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Concurrent Conflict Resolution Modal */}
      {conflict && (
        <ExpenseConflictModal
          open={Boolean(conflict)}
          onClose={() => setConflict(null)}
          conflict={conflict}
          onReloadLatest={handleReloadLatest}
          onResolveAndMerge={handleResolveAndMerge}
        />
      )}
    </>
  );
}
