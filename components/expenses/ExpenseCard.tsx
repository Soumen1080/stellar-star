"use client";

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRightLeft, Ban, ChevronRight, ReceiptText, Trash2 } from "lucide-react";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import { SplitCalculator } from "@/components/expenses/SplitCalculator";
import { ExpenseReceipts } from "@/components/expenses/ExpenseReceipts";
import { VoidExpenseModal } from "@/components/expenses/VoidExpenseModal";
import { CorrectExpenseModal } from "@/components/expenses/CorrectExpenseModal";
import { usePayment } from "@/hooks/usePayment";
import { useExpense } from "@/hooks/useExpense";
import { categoryLabel } from "@/lib/expense/categories";
import { isExpenseSettledOrPartiallyPaid } from "@/lib/expense/corrections";
import type { Expense, SplitShare } from "@/types/expense";

import { Money } from "@/components/ui/Money";
import { useLocale } from "@/context/LocaleContext";
import { describeSavedConversion, enteredAmountOf } from "@/lib/fx/quoteLock";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { shareBalance } from "@/lib/settlement/installments";
import { AssetReadinessPanel } from "@/components/onboarding/AssetReadinessPanel";

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
  const [showVoidModal, setShowVoidModal] = useState(false);
  const [showCorrectModal, setShowCorrectModal] = useState(false);

  const { voidExpense, createCorrection } = useExpense();

  const {
    payShare,
    paymentState,
    reset,
    retryOnChainRecord,
    poolBalance,
    depositLoading,
    depositPool,
  } = usePayment({ expenseId: expense.id });

  const { formatDate, t } = useLocale();
  const paidCount = expense.shares.filter((share) => share.paid).length;
  const payer = expense.members.find((member) => member.id === expense.paidByMemberId);
  const createdAt = formatDate(expense.createdAt, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  const isOwner =
    !!currentUserPublicKey &&
    !!payer?.walletAddress &&
    payer.walletAddress.trim().toUpperCase() === currentUserPublicKey.trim().toUpperCase();

  const isSettledOrPaid = isExpenseSettledOrPartiallyPaid(expense);

  // Exact: the saved entered amount, or an exact BigInt reconstruction for
  // rows saved before #323. Never float division.
  const fiatAmount = enteredAmountOf(expense);
  const connectedShare = currentUserPublicKey
    ? expense.shares.find((share) => share.walletAddress === currentUserPublicKey && share.memberId !== expense.paidByMemberId && !shareBalance(share).fullySettled)
    : undefined;
  const connectedShareAmount = connectedShare ? shareBalance(connectedShare).remaining : null;
  const readinessKey = `${currentUserPublicKey ?? ""}:${expense.id}:${settlementAssetOf(expense)}:${connectedShareAmount ?? ""}`;
  // Readiness callback placeholder

  const handlePay = async (share: SplitShare, amount?: string) => {
    if (expense.voided) return;
    setPayingShareId(share.memberId);
    // Pay against the stored share, not the display-adjusted copy the
    // calculator renders, so the remaining balance is computed exactly.
    const stored = expense.shares.find((s) => s.memberId === share.memberId) ?? share;
    await payShare({
      share: stored,
      expenseTitle: expense.title,
      payerWalletAddress: payer?.walletAddress ?? "",
      tripId,
      amount,
    });
    setPayingShareId(null);
  };

  return (
    <>
      <motion.div
        layout
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.97 }}
        className={`bg-white rounded-2xl border transition-all overflow-hidden ${
          expense.voided
            ? "border-amber-200 bg-amber-50/20 hover:border-amber-300 opacity-80"
            : expense.correctionOfExpenseId
            ? "border-purple-200 hover:border-purple-300"
            : "border-[#E5E5E5] hover:border-[#D0D0D0]"
        }`}
      >
        <button
          className="w-full flex items-start sm:items-center justify-between gap-3 p-4 text-left"
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                expense.voided
                  ? "bg-amber-100 text-amber-700"
                  : expense.correctionOfExpenseId
                  ? "bg-purple-900 text-purple-300"
                  : "bg-[#0F0F14] text-[#2DD4BF]"
              }`}
            >
              {expense.voided ? (
                <Ban size={15} />
              ) : expense.correctionOfExpenseId ? (
                <ArrowRightLeft size={15} />
              ) : (
                <ReceiptText size={15} />
              )}
            </div>
            <div className="min-w-0">
              <p
                className={`text-sm font-bold truncate ${
                  expense.voided ? "line-through text-[#888]" : "text-[#0F0F14]"
                }`}
              >
                {expense.title}
              </p>
              <p className="text-xs text-[#AAA] leading-relaxed flex flex-wrap items-center gap-1">
                <Money amount={expense.totalAmount} asset="XLM" />
                {fiatAmount !== null && (
                  <>
                    <span>({t("expenses.agreedAs")}{" "}</span>
                    <Money amount={fiatAmount} asset={expense.currency} />
                    <span>)</span>
                  </>
                )}
                <span>
                  &middot; {t("expenses.membersCount", { count: String(expense.members.length) })} &middot; {createdAt}
                </span>
              </p>
              {(expense.category || (expense.tags?.length ?? 0) > 0) && (
                <p className="mt-1 flex flex-wrap items-center gap-1 text-[10px]">
                  {expense.category && (
                    <span className="rounded-full bg-[#F0F0F0] px-2 py-0.5 font-semibold text-[#444]">
                      <span className="sr-only">Category: </span>
                      {categoryLabel(expense.category)}
                    </span>
                  )}
                  {expense.tags?.map((tag) => (
                    <span key={tag} className="rounded-full border border-[#E5E5E5] px-2 py-0.5 text-[#666]">
                      <span className="sr-only">Tag: </span>#{tag}
                    </span>
                  ))}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            {expense.voided ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-amber-100 text-amber-800 border border-amber-300 rounded-full">
                Voided
              </span>
            ) : expense.correctionOfExpenseId ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-purple-100 text-purple-800 border border-purple-200 rounded-full">
                {expense.correctionType || "Correction"}
              </span>
            ) : expense.settled ? (
              <span className="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                {t("expenses.settled")}
              </span>
            ) : (
              <span className="text-xs text-[#888]">
                {t("expenses.paidRatio", {
                  paid: String(paidCount),
                  total: String(expense.shares.length),
                })}
              </span>
            )}
            <ChevronRight
              size={14}
              className={`text-[#CCC] transition-transform duration-200 ${expanded ? "rotate-90" : ""}`}
            />
          </div>
        </button>

        {!expense.voided && expense.shares.length > 0 && (
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
                {expense.voided && (
                  <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
                    <div className="flex items-center gap-1.5 font-bold mb-1">
                      <Ban size={14} className="text-amber-600" />
                      <span>This expense has been voided</span>
                    </div>
                    <p className="text-amber-800 leading-relaxed">
                      <strong>Audit Reason:</strong> {expense.voidReason}
                    </p>
                    {expense.voidedAt && (
                      <p className="mt-1 text-[10px] text-amber-700">
                        Voided on {formatDate(expense.voidedAt, { month: "short", day: "numeric", year: "numeric" })}
                      </p>
                    )}
                  </div>
                )}

                {expense.correctionOfExpenseId && (
                  <div className="mb-3 rounded-xl border border-purple-200 bg-purple-50 p-3 text-xs text-purple-900">
                    <div className="flex items-center gap-1.5 font-bold mb-1">
                      <ArrowRightLeft size={14} className="text-purple-600" />
                      <span>Linked {expense.correctionType || "Correction"} Record</span>
                    </div>
                    {expense.correctionReason && (
                      <p className="text-purple-800 leading-relaxed">
                        <strong>Audit Reason:</strong> {expense.correctionReason}
                      </p>
                    )}
                  </div>
                )}

                <p className="mb-3 rounded-lg bg-[#FAFAFA] px-3 py-2 text-[11px] text-[#666]" title="Saved with the expense; cannot be edited">
                  <span className="font-semibold text-[#444]">{t("expenses.exchangeRateLabel")} </span>
                  {describeSavedConversion(expense)}
                </p>

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
                  disablePay={expense.voided}
                  payingShareId={payingShareId ?? undefined}
                  connectedWalletAddress={currentUserPublicKey}
                  poolBalance={poolBalance}
                  depositLoading={depositLoading}
                  onDepositPool={depositPool}
                  paymentRequest={
                    tripId && !expense.voided
                      ? { tripId, expenseId: expense.id, asset: settlementAssetOf(expense) }
                      : undefined
                  }
                />

                {!expense.voided && paymentState.status !== "idle" && (
                  <div className="mt-3">
                    <PaymentStatus
                      state={paymentState}
                      onReset={reset}
                      onRetryOnChain={retryOnChainRecord}
                    />
                  </div>
                )}

                <ExpenseReceipts
                  expenseId={expense.id}
                  canUpload={isOwner && !expense.voided}
                  currentUserPublicKey={currentUserPublicKey}
                />

                <ExpenseCardFooter
                  expense={expense}
                  isSettledOrPaid={isSettledOrPaid}
                  confirmDelete={confirmDelete}
                  canDelete={!!onDelete && isOwner && !isSettledOrPaid && !expense.voided}
                  showDeleteHint={!!onDelete && !expense.voided && !isSettledOrPaid}
                  onCancelDelete={() => setConfirmDelete(false)}
                  onConfirmDelete={() => onDelete?.(expense.id)}
                  onRequestDelete={() => setConfirmDelete(true)}
                  onOpenVoid={() => setShowVoidModal(true)}
                  onOpenCorrect={() => setShowCorrectModal(true)}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {showVoidModal && (
        <VoidExpenseModal
          open={showVoidModal}
          onClose={() => setShowVoidModal(false)}
          expense={expense}
          onVoidExpense={voidExpense}
        />
      )}

      {showCorrectModal && (
        <CorrectExpenseModal
          open={showCorrectModal}
          onClose={() => setShowCorrectModal(false)}
          expense={expense}
          tripId={tripId}
          currentUserPublicKey={currentUserPublicKey}
          onCreateCorrection={createCorrection}
        />
      )}
    </>
  );
}

interface ExpenseCardFooterProps {
  expense: Expense;
  isSettledOrPaid: boolean;
  confirmDelete: boolean;
  canDelete: boolean;
  canEdit?: boolean;
  showDeleteHint: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRequestDelete: () => void;
  onOpenVoid: () => void;
  onOpenCorrect: () => void;
}

function ExpenseCardFooter({
  expense,
  isSettledOrPaid,
  confirmDelete,
  canDelete,
  canEdit,
  showDeleteHint,
  onCancelDelete,
  onConfirmDelete,
  onRequestDelete,
  onOpenVoid,
  onOpenCorrect,
}: ExpenseCardFooterProps) {
  const { t } = useLocale();

  if (confirmDelete) {
    return (
      <div className="mt-3 pt-3 border-t border-[#F5F5F5]">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200">
          <p className="text-xs text-red-600 font-medium">
            {t("expenses.deleteConfirm", { title: expense.title })}
          </p>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={(event) => {
                event.stopPropagation();
                onCancelDelete();
              }}
              className="text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
            >
              {t("common.cancel")}
            </button>
            <button
              onClick={(event) => {
                event.stopPropagation();
                onConfirmDelete();
              }}
              className="inline-flex items-center gap-1 text-xs font-bold text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded-lg transition-colors"
            >
              <Trash2 size={11} />
              {t("common.delete")}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-3 pt-3 border-t border-[#F5F5F5]">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[#CCC] break-words">
          {t("expenses.splitLabel", { mode: expense.splitMode })}
        </span>

        <div className="flex items-center gap-2">
          {expense.voided ? (
            <span className="text-[11px] text-amber-700 italic flex items-center gap-1">
              <Ban size={11} /> Voided (Retained in history)
            </span>
          ) : isSettledOrPaid ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenCorrect();
              }}
              className="inline-flex items-center gap-1.5 text-xs font-bold px-2.5 py-1 rounded-lg bg-[#0F0F14] text-[#2DD4BF] hover:bg-[#1A1A22] transition-colors"
            >
              <ArrowRightLeft size={12} />
              Correct / Adjust
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onOpenVoid();
              }}
              className="inline-flex items-center gap-1 text-xs font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 px-2 py-0.5 rounded-lg transition-colors"
            >
              <Ban size={11} />
              Void
            </button>
          )}

          {canDelete && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onRequestDelete();
              }}
              className="flex items-center gap-1.5 text-xs font-medium text-[#CCC] hover:text-red-500 transition-colors"
            >
              <Trash2 size={12} />
              {t("common.delete")}
            </button>
          )}
          {showDeleteHint && (
            <span className="text-[10px] text-[#CCC] italic">{t("expenses.onlyPayerCanDelete")}</span>
          )}
        </div>
      </div>
    </div>
  );
}
