"use client";

import { useState } from "react";
import { ArrowRightLeft, CheckCircle2, History, ShieldCheck } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { Money } from "@/components/ui/Money";
import { Money as MoneyCalc } from "@/lib/money";
import {
  MIN_AUDIT_REASON_LENGTH,
  MAX_AUDIT_REASON_LENGTH,
  buildLinkedReversal,
  buildLinkedAdjustment,
} from "@/lib/expense/corrections";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import type { Expense } from "@/types/expense";

interface CorrectExpenseModalProps {
  open: boolean;
  onClose: () => void;
  expense: Expense;
  tripId?: string;
  currentUserPublicKey?: string | null;
  onCorrectionSuccess?: (correction: Expense) => void;
  onCreateCorrection?: (correction: Expense) => Promise<Expense>;
}

export function CorrectExpenseModal({
  open,
  onClose,
  expense,
  tripId,
  currentUserPublicKey,
  onCorrectionSuccess,
  onCreateCorrection,
}: CorrectExpenseModalProps) {
  const [correctionType, setCorrectionType] = useState<"reversal" | "adjustment">("reversal");
  const [newTotalAmount, setNewTotalAmount] = useState(expense.totalAmount);
  const [reason, setReason] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { success, error: toastError } = useToast();

  const trimmedReason = reason.trim();
  const isReasonValid = trimmedReason.length >= MIN_AUDIT_REASON_LENGTH && trimmedReason.length <= MAX_AUDIT_REASON_LENGTH;

  const originalTotalMoney = MoneyCalc.tryParse(expense.totalAmount) ?? MoneyCalc.zero();
  const newTotalMoney = MoneyCalc.tryParse(newTotalAmount);
  const isAmountValid = correctionType === "reversal" || (newTotalMoney && newTotalMoney.isPositive());

  const differenceMoney =
    newTotalMoney && originalTotalMoney
      ? newTotalMoney.minus(originalTotalMoney)
      : MoneyCalc.zero();

  const handleCreateCorrection = async () => {
    if (!isReasonValid) {
      setError(`Please provide an audit reason of at least ${MIN_AUDIT_REASON_LENGTH} characters.`);
      return;
    }

    if (correctionType === "adjustment" && !isAmountValid) {
      setError("Please enter a valid positive total amount.");
      return;
    }

    setIsSubmitting(true);
    setError(null);

    try {
      const actorWallet = currentUserPublicKey || (expense as any).createdByWallet || "";
      let correctionRecord: Expense;

      if (correctionType === "reversal") {
        correctionRecord = buildLinkedReversal({
          originalExpense: expense,
          reason: trimmedReason,
          actorWallet,
        });
      } else {
        correctionRecord = buildLinkedAdjustment({
          originalExpense: expense,
          reason: trimmedReason,
          adjustmentType: "adjustment",
          actorWallet,
          adjustedTotalAmount: newTotalAmount,
        });
      }

      let saved: Expense;
      if (onCreateCorrection) {
        saved = await onCreateCorrection(correctionRecord);
      } else {
        const response = await fetch(`/api/expenses/${encodeURIComponent(expense.id)}/correct`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            correctionType,
            reason: trimmedReason,
            adjustedTotalAmount: newTotalAmount,
            tripId,
          }),
        });
        const json = await response.json();
        if (!response.ok) {
          throw new Error(json.error || "Failed to create linked correction.");
        }
        saved = json.data;
      }

      success(
        "Linked correction created",
        correctionType === "reversal"
          ? "Reversal record created to offset settled payments."
          : "Adjustment record created. Effective balances updated."
      );
      onCorrectionSuccess?.(saved);
      onClose();
    } catch (err: any) {
      const msg = err instanceof Error ? err.message : "Failed to create correction.";
      setError(msg);
      toastError("Correction failed", msg);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Correct Settled Expense"
      description={`Create a non-destructive linked adjustment for "${expense.title}".`}
      size="lg"
    >
      <div className="space-y-4 pt-2">
        {/* On-Chain Proof Preserved Banner */}
        <div className="rounded-xl border border-teal-200 bg-teal-50/70 p-3 flex gap-2.5 items-start text-xs text-teal-900">
          <ShieldCheck size={16} className="text-teal-600 shrink-0 mt-0.5" />
          <div className="space-y-1">
            <p className="font-semibold text-teal-900">On-Chain Proof & Ledger Invariants Preserved</p>
            <p className="text-teal-800 leading-relaxed">
              Real transactions settled on Stellar cannot be deleted. This workflow creates a linked,
              non-destructive record that references the original expense ID ({expense.id.slice(0, 8)}...)
              and adjusts the effective balance without erasing financial history.
            </p>
          </div>
        </div>

        {error && (
          <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-xs text-red-700">
            {error}
          </div>
        )}

        {/* Correction Type Selection */}
        <div>
          <label className="block text-xs font-semibold text-[#0F0F14] mb-2">Correction Method</label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              onClick={() => setCorrectionType("reversal")}
              className={`p-3 rounded-xl border text-left transition-all ${
                correctionType === "reversal"
                  ? "border-[#2DD4BF] bg-[#2DD4BF]/5 ring-1 ring-[#2DD4BF]"
                  : "border-[#E5E5E5] bg-white hover:border-[#D0D0D0]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-[#0F0F14]">Full Reversal</span>
                {correctionType === "reversal" && <CheckCircle2 size={14} className="text-[#2DD4BF]" />}
              </div>
              <p className="text-[11px] text-[#666] leading-relaxed">
                Offsets settled payments by crediting members who paid. Recommended for cancelled expenses or duplicates.
              </p>
            </button>

            <button
              type="button"
              onClick={() => setCorrectionType("adjustment")}
              className={`p-3 rounded-xl border text-left transition-all ${
                correctionType === "adjustment"
                  ? "border-[#2DD4BF] bg-[#2DD4BF]/5 ring-1 ring-[#2DD4BF]"
                  : "border-[#E5E5E5] bg-white hover:border-[#D0D0D0]"
              }`}
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-bold text-[#0F0F14]">Adjustment / Offset</span>
                {correctionType === "adjustment" && <CheckCircle2 size={14} className="text-[#2DD4BF]" />}
              </div>
              <p className="text-[11px] text-[#666] leading-relaxed">
                Adjusts total amount or member shares. Recomputes remaining balances using exact money arithmetic.
              </p>
            </button>
          </div>
        </div>

        {/* Adjustment Amount Inputs */}
        {correctionType === "adjustment" && (
          <div className="rounded-xl border border-[#E5E5E5] bg-[#FAFAFA] p-3 space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <span className="text-[11px] text-[#888] font-medium block mb-1">Original Settled Amount</span>
                <p className="text-sm font-bold text-[#0F0F14]">
                  <Money amount={expense.totalAmount} asset={settlementAssetOf(expense)} />
                </p>
              </div>

              <div>
                <label htmlFor="new-total" className="text-[11px] text-[#444] font-semibold block mb-1">
                  Adjusted Total Amount
                </label>
                <input
                  id="new-total"
                  type="text"
                  value={newTotalAmount}
                  onChange={(e) => setNewTotalAmount(e.target.value)}
                  placeholder="e.g. 85.00"
                  className="w-full text-xs p-2 rounded-lg border border-[#E5E5E5] bg-white focus:outline-none focus:ring-2 focus:ring-[#2DD4BF]"
                />
              </div>
            </div>

            {differenceMoney && (
              <div className="text-[11px] flex items-center gap-1.5 pt-2 border-t border-[#EAEAEA]">
                <span className="text-[#666]">Net Adjustment Delta:</span>
                <span className={`font-bold ${differenceMoney.isNegative() ? "text-amber-600" : "text-teal-600"}`}>
                  {differenceMoney.isNegative() ? "" : "+"}
                  {differenceMoney.format(7)} {settlementAssetOf(expense)}
                </span>
                <span className="text-[#888]">
                  ({differenceMoney.isNegative() ? "Refund offset" : "Additional charge"})
                </span>
              </div>
            )}
          </div>
        )}

        {/* Audit Reason */}
        <div>
          <label htmlFor="correct-reason" className="block text-xs font-semibold text-[#0F0F14] mb-1.5">
            Audit Reason <span className="text-red-500">*</span>
          </label>
          <textarea
            id="correct-reason"
            rows={3}
            value={reason}
            onChange={(e) => {
              setReason(e.target.value);
              if (error) setError(null);
            }}
            placeholder="Explain why this correction is necessary (e.g. Supplier issued a partial refund, Wrong item price calculated, Split recalculation)..."
            className="w-full text-xs p-3 rounded-xl border border-[#E5E5E5] bg-white focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] focus:border-transparent transition-all resize-none"
            maxLength={MAX_AUDIT_REASON_LENGTH}
            disabled={isSubmitting}
          />
          <div className="flex justify-between items-center mt-1 text-[11px] text-[#888]">
            <span>Minimum {MIN_AUDIT_REASON_LENGTH} characters</span>
            <span>
              {trimmedReason.length}/{MAX_AUDIT_REASON_LENGTH}
            </span>
          </div>
        </div>

        {/* Footer Actions */}
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
            onClick={handleCreateCorrection}
            disabled={!isReasonValid || !isAmountValid || isSubmitting}
            className="text-xs font-bold bg-[#0F0F14] hover:bg-[#1A1A22] text-[#2DD4BF] gap-1.5"
          >
            <ArrowRightLeft size={13} />
            {isSubmitting ? "Creating Correction..." : "Create Linked Correction"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
