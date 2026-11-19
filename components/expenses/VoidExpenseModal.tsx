"use client";

import { useState } from "react";
import { AlertCircle, Ban } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { MIN_AUDIT_REASON_LENGTH, MAX_AUDIT_REASON_LENGTH } from "@/lib/expense/corrections";
import type { Expense } from "@/types/expense";

interface VoidExpenseModalProps {
  open: boolean;
  onClose: () => void;
  expense: Expense;
  onVoidSuccess?: (voided: Expense) => void;
  onVoidExpense?: (id: string, reason: string) => Promise<Expense>;
}

export function VoidExpenseModal({
  open,
  onClose,
  expense,
  onVoidSuccess,
  onVoidExpense,
}: VoidExpenseModalProps) {
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const trimmed = reason.trim();
  const isValid = trimmed.length >= MIN_AUDIT_REASON_LENGTH && trimmed.length <= MAX_AUDIT_REASON_LENGTH;

  const handleVoid = async () => {
    if (!isValid) {
      setError(`Please provide an audit reason of at least ${MIN_AUDIT_REASON_LENGTH} characters.`);
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      let voided: Expense;
      if (onVoidExpense) {
        voided = await onVoidExpense(expense.id, trimmed);
      } else {
        const response = await fetch(`/api/expenses/${encodeURIComponent(expense.id)}/void`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ reason: trimmed }),
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.error || "Failed to void expense.");
        }
        voided = json.data;
      }

      success("Expense voided", "The expense was voided and excluded from trip balances.");
      onVoidSuccess?.(voided);
      onClose();
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : "Failed to void expense.";
      setError(msg);
      toastError("Void failed", msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Void Unsettled Expense"
      description={`Voiding "${expense.title}" will remove it from outstanding balances while preserving a permanent audit trail.`}
      size="md"
    >
      <div className="space-y-4 pt-2">
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex gap-2.5 items-start text-xs text-amber-900">
          <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold">Financial History Protection</p>
            <p className="text-amber-800 leading-relaxed">
              Instead of destructive deletion, voiding preserves full auditability.
              This expense will show as &quot;Voided&quot; in the history and contribute 0 to member balances.
              This action cannot be undone.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        <div>
          <label htmlFor="void-reason" className="block text-xs font-semibold text-[#0F0F14] mb-1.5">
            Audit Reason <span className="text-red-500">*</span>
          </label>
          <textarea
            id="void-reason"
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Explain why this expense is being voided (e.g. Duplicate entry, Wrong currency entered, Event cancelled)..."
            className="w-full text-xs p-3 rounded-xl border border-[#E5E5E5] bg-white focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] focus:border-transparent transition-all resize-none"
            maxLength={MAX_AUDIT_REASON_LENGTH}
            disabled={isSubmitting}
          />
          <div className="flex justify-between items-center mt-1 text-[11px] text-[#888]">
            <span>Minimum {MIN_AUDIT_REASON_LENGTH} characters</span>
            <span>
              {trimmed.length}/{MAX_AUDIT_REASON_LENGTH}
            </span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 pt-2 border-t border-[#F0F0F0]">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={isSubmitting}
            className="text-xs"
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleVoid}
            disabled={!isValid || isSubmitting}
            className="text-xs font-bold bg-amber-600 hover:bg-amber-700 text-white gap-1.5"
          >
            <Ban size={13} />
            {isSubmitting ? "Voiding..." : "Confirm Void"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
