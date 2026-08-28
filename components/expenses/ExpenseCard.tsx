"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, ReceiptText, Trash2 } from "lucide-react";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import { SplitCalculator } from "@/components/expenses/SplitCalculator";
import { usePayment } from "@/hooks/usePayment";
import type { Expense, SplitShare } from "@/types/expense";

interface ExpenseCardProps {
  expense: Expense;
  currentUserPublicKey?: string | null;
  onDelete?: (id: string) => void;
  tripId?: string;
}

export function ExpenseCard({ expense, currentUserPublicKey, onDelete, tripId }: ExpenseCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [payingShareId, setPayingShareId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const {
    payShare,
    paymentState,
    reset,
    retryOnChainRecord,
    poolBalance,
    depositLoading,
    depositPool,
  } = usePayment({ expenseId: expense.id });

  const paidCount = expense.shares.filter((share) => share.paid).length;
  const total = parseFloat(expense.totalAmount);
  const payer = expense.members.find((member) => member.id === expense.paidByMemberId);
  const createdAt = new Date(expense.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const isOwner =
    !!currentUserPublicKey &&
    !!payer?.walletAddress &&
    payer.walletAddress === currentUserPublicKey;

  const fiatAmount =
    expense.currency !== "XLM" && expense.exchangeRate
      ? (parseFloat(expense.totalAmount) / parseFloat(expense.exchangeRate)).toFixed(2)
      : null;

  const handlePay = async (share: SplitShare) => {
    setPayingShareId(share.memberId);
    await payShare({
      share,
      expenseTitle: expense.title,
      payerWalletAddress: payer?.walletAddress ?? "",
      tripId,
    });
    setPayingShareId(null);
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="bg-white rounded-2xl border border-[#E5E5E5] overflow-hidden hover:border-[#D0D0D0] transition-all"
    >
      <button
        className="w-full flex items-start sm:items-center justify-between gap-3 p-4 text-left"
        onClick={() => setExpanded((value) => !value)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#0F0F14] flex items-center justify-center shrink-0">
            <ReceiptText size={15} className="text-[#2DD4BF]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F0F14] truncate">{expense.title}</p>
            <p className="text-xs text-[#AAA] leading-relaxed">
              {total.toFixed(4)} XLM{fiatAmount ? ` (agreed as ${fiatAmount} ${expense.currency})` : ""} &middot; {expense.members.length} members &middot; {createdAt}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {expense.settled ? (
            <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
              Settled
            </span>
          ) : (
            <span className="text-xs text-[#888]">
              {paidCount}/{expense.shares.length} paid
            </span>
          )}
          <ChevronRight
            size={14}
            className={`text-[#CCC] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
          />
        </div>
      </button>

      {expense.shares.length > 0 && (
        <div className="h-0.5 w-full bg-[#F0F0F0]">
          <div
            className="h-full bg-[#2DD4BF] transition-all duration-500"
            style={{ width: `${(paidCount / expense.shares.length) * 100}%` }}
          />
        </div>
      )}

      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            key="detail"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden"
          >
            <div className="px-4 pt-3 pb-4 border-t border-[#F5F5F5]">
              {expense.description && (
                <p className="text-xs text-[#888] mb-3 leading-relaxed">{expense.description}</p>
              )}

              <SplitCalculator
                shares={expense.shares}
                payerName={payer?.name ?? "Payer"}
                payerWalletAddress={payer?.walletAddress}
                totalAmount={expense.totalAmount}
                expenseTitle={expense.title}
                onPay={handlePay}
                payingShareId={payingShareId ?? undefined}
                connectedWalletAddress={currentUserPublicKey}
                poolBalance={poolBalance}
                depositLoading={depositLoading}
                onDepositPool={depositPool}
              />

              {paymentState.status !== "idle" && (
                <div className="mt-3">
                  <PaymentStatus
                    state={paymentState}
                    onReset={reset}
                    onRetryOnChain={retryOnChainRecord}
                  />
                </div>
              )}

              <ExpenseCardFooter
                expense={expense}
                confirmDelete={confirmDelete}
                canDelete={!!onDelete && isOwner}
                showDeleteHint={!!onDelete}
                onCancelDelete={() => setConfirmDelete(false)}
                onConfirmDelete={() => onDelete?.(expense.id)}
                onRequestDelete={() => setConfirmDelete(true)}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

interface ExpenseCardFooterProps {
  expense: Expense;
  confirmDelete: boolean;
  canDelete: boolean;
  showDeleteHint: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRequestDelete: () => void;
}

function ExpenseCardFooter({
  expense,
  confirmDelete,
  canDelete,
  showDeleteHint,
  onCancelDelete,
  onConfirmDelete,
  onRequestDelete,
}: ExpenseCardFooterProps) {
  if (confirmDelete) {
    return (
      <div className="mt-3 pt-3 border-t border-[#F5F5F5]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200">
          <p className="text-xs text-red-600 font-medium">
            Delete &ldquo;{expense.title}&rdquo;? This cannot be undone.
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onCancelDelete();
              }}
              className="text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onConfirmDelete();
              }}
              className="inline-flex items-center gap-1 text-xs font-bold text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded-lg transition-colors"
            >
              <Trash2 size={11} />
              Delete
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#F5F5F5]">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[#CCC] break-words">
          Split: {expense.splitMode}
        </span>
        {canDelete ? (
          <button
            onClick={(event) => {
              event.stopPropagation();
              onRequestDelete();
            }}
            className="flex items-center gap-1.5 text-xs font-medium text-[#CCC] hover:text-red-500 transition-colors"
          >
            <Trash2 size={12} />
            Delete
          </button>
        ) : showDeleteHint ? (
          <span className="text-[10px] text-[#CCC] italic">Only the payer can delete</span>
        ) : null}
      </div>
    </div>
  );
}
