"use client";

import { useCallback, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronRight, ReceiptText, Trash2, Pencil } from "lucide-react";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import { SplitCalculator } from "@/components/expenses/SplitCalculator";
import { ExpenseReceipts } from "@/components/expenses/ExpenseReceipts";
import { EditExpenseModal } from "@/components/expenses/EditExpenseModal";
import { usePayment } from "@/hooks/usePayment";
import { categoryLabel } from "@/lib/expense/categories";
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
  const [showEditModal, setShowEditModal] = useState(false);
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
    payer.walletAddress === currentUserPublicKey;

  // Exact: the saved entered amount, or an exact BigInt reconstruction for
  // rows saved before #323. Never float division.
  const fiatAmount = enteredAmountOf(expense);
  const connectedShare = currentUserPublicKey
    ? expense.shares.find((share) => share.walletAddress === currentUserPublicKey && share.memberId !== expense.paidByMemberId && !shareBalance(share).fullySettled)
    : undefined;
  const connectedShareAmount = connectedShare ? shareBalance(connectedShare).remaining : null;
  const readinessKey = `${currentUserPublicKey ?? ""}:${expense.id}:${settlementAssetOf(expense)}:${connectedShareAmount ?? ""}`;
  const readinessChanged = useCallback((ready: boolean) => setWalletReady({ key: readinessKey, ready }), [readinessKey]);

  const handlePay = async (share: SplitShare, amount?: string) => {
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
          {expense.settled ? (
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
              {connectedShare && currentUserPublicKey && connectedShareAmount && (
                <div className="mb-3">
                  <AssetReadinessPanel
                    publicKey={currentUserPublicKey}
                    assetKey={settlementAssetOf(expense)}
                    requiredAmount={connectedShareAmount}
                    recipientAddress={payer?.walletAddress ?? ""}
                    onReadyChange={readinessChanged}
                  />
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
                disablePay={!!connectedShare && !(walletReady?.key === readinessKey && walletReady.ready)}
                expenseTitle={expense.title}
                onPay={handlePay}
                payingShareId={payingShareId ?? undefined}
                connectedWalletAddress={currentUserPublicKey}
                poolBalance={poolBalance}
                depositLoading={depositLoading}
                onDepositPool={depositPool}
                paymentRequest={
                  tripId ? { tripId, expenseId: expense.id, asset: settlementAssetOf(expense) } : undefined
                }
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

              <ExpenseReceipts
                expenseId={expense.id}
                canUpload={isOwner}
                currentUserPublicKey={currentUserPublicKey}
              />

              <ExpenseCardFooter
                expense={expense}
                confirmDelete={confirmDelete}
                canDelete={!!onDelete && isOwner}
                canEdit={!expense.settled && (isOwner || !currentUserPublicKey || expense.members.some(m => m.walletAddress === currentUserPublicKey))}
                showDeleteHint={!!onDelete}
                onCancelDelete={() => setConfirmDelete(false)}
                onConfirmDelete={() => onDelete?.(expense.id)}
                onRequestDelete={() => setConfirmDelete(true)}
                onEdit={() => setShowEditModal(true)}
              />

              <EditExpenseModal
                open={showEditModal}
                onClose={() => setShowEditModal(false)}
                expense={expense}
                currentUserPublicKey={currentUserPublicKey}
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
  canEdit: boolean;
  showDeleteHint: boolean;
  onCancelDelete: () => void;
  onConfirmDelete: () => void;
  onRequestDelete: () => void;
  onEdit: () => void;
}

function ExpenseCardFooter({
  expense,
  confirmDelete,
  canDelete,
  canEdit,
  showDeleteHint,
  onCancelDelete,
  onConfirmDelete,
  onRequestDelete,
  onEdit,
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
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wider font-semibold text-[#CCC] break-words">
          {t("expenses.splitLabel", { mode: expense.splitMode })}
        </span>
        <div className="flex items-center gap-3">
          {canEdit && (
            <button
              onClick={(event) => {
                event.stopPropagation();
                onEdit();
              }}
              className="flex items-center gap-1 text-xs font-medium text-[#888] hover:text-[#0F0F14] transition-colors"
              title="Edit Expense"
            >
              <Pencil size={12} />
              Edit
            </button>
          )}

          {canDelete ? (
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
          ) : showDeleteHint ? (
            <span className="text-[10px] text-[#CCC] italic">{t("expenses.onlyPayerCanDelete")}</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
