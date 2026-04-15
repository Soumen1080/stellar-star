"use client";

import React, { useState } from "react";
import Link from "next/link";
import { motion, AnimatePresence } from "framer-motion";
import {
  Plus,
  ArrowLeft,
  ReceiptText,
  Trash2,
  ChevronRight,
  Inbox,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useAuth } from "@/context/AuthContext";
import { useExpense } from "@/hooks/useExpense";
import { usePayment } from "@/hooks/usePayment";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Modal } from "@/components/ui/Modal";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { SplitCalculator } from "@/components/expenses/SplitCalculator";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import type { Expense, SplitShare } from "@/types/expense";

// ─── Expense Card ─────────────────────────────────────────────────────────────

function ExpenseCard({
  expense,
  onDelete,
  currentUserPublicKey,
}: {
  expense: Expense;
  onDelete: (id: string) => void;
  currentUserPublicKey?: string | null;
}) {
  const [expanded, setExpanded] = useState(false);
  const [payingShareId, setPayingShareId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Only the payer (the person who created/paid the expense) can delete it.
  const payerMember = expense.members.find((m) => m.id === expense.paidByMemberId);
  const isOwner =
    !!currentUserPublicKey &&
    !!payerMember?.walletAddress &&
    payerMember.walletAddress === currentUserPublicKey;
  const { payShare, paymentState, reset, retryOnChainRecord } = usePayment({ expenseId: expense.id });

  const handlePay = async (share: SplitShare) => {
    setPayingShareId(share.memberId);
    await payShare({
      share,
      expenseTitle: expense.title,
      payerWalletAddress: payer?.walletAddress ?? "",
    });
    setPayingShareId(null);
  };
  const paidCount = expense.shares.filter((s) => s.paid).length;
  const total = parseFloat(expense.totalAmount);
  const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
  const createdAt = new Date(expense.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="bg-white rounded-2xl border border-[#E5E5E5] overflow-hidden hover:border-[#D0D0D0] transition-all"
    >
      {/* Header row */}
      <button
        className="w-full flex items-start sm:items-center justify-between gap-3 p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#0F0F14] flex items-center justify-center shrink-0">
            <ReceiptText size={15} className="text-[#2DD4BF]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F0F14] truncate">
              {expense.title}
            </p>
            <p className="text-xs text-[#AAA] leading-relaxed">
              {total.toFixed(4)} XLM &middot; {expense.members.length} members
              &middot; {createdAt}
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
            className={`text-[#CCC] transition-transform duration-200 ${
              expanded ? "rotate-90" : ""
            }`}
          />
        </div>
      </button>

      {/* Progress bar */}
      {expense.shares.length > 0 && (
        <div className="h-0.5 w-full bg-[#F0F0F0]">
          <div
            className="h-full bg-[#2DD4BF] transition-all duration-500"
            style={{
              width: `${(paidCount / expense.shares.length) * 100}%`,
            }}
          />
        </div>
      )}

      {/* Expanded detail */}
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
                <p className="text-xs text-[#888] mb-3 leading-relaxed">
                  {expense.description}
                </p>
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

              <div className="mt-3 pt-3 border-t border-[#F5F5F5]">
                {confirmDelete ? (
                  /* ── Confirmation strip ── */
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-3 py-2 rounded-xl bg-red-50 border border-red-200">
                    <p className="text-xs text-red-600 font-medium">
                      Delete &ldquo;{expense.title}&rdquo;? This cannot be undone.
                    </p>
                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(false); }}
                        className="text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
                      >
                        Cancel
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); onDelete(expense.id); }}
                        className="inline-flex items-center gap-1 text-xs font-bold text-white bg-red-500 hover:bg-red-600 px-3 py-1 rounded-lg transition-colors"
                      >
                        <Trash2 size={11} />
                        Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-wider font-semibold text-[#CCC] break-words">
                      Split: {expense.splitMode}
                    </span>
                    {isOwner ? (
                      <button
                        onClick={(e) => { e.stopPropagation(); setConfirmDelete(true); }}
                        className="flex items-center gap-1.5 text-xs font-medium text-[#CCC] hover:text-red-500 transition-colors"
                      >
                        <Trash2 size={12} />
                        Delete
                      </button>
                    ) : (
                      <span className="text-[10px] text-[#CCC] italic">
                        Only the payer can delete
                      </span>
                    )}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyState({ onNew }: { onNew: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex flex-col items-center justify-center py-16 px-4 text-center"
    >
      <div className="w-16 h-16 rounded-2xl bg-[#F0F0F0] flex items-center justify-center mb-5">
        <Inbox size={24} className="text-[#CCC]" />
      </div>
      <h3 className="text-base font-bold text-[#0F0F14] mb-1">
        No expenses yet
      </h3>
      <p className="text-sm text-[#AAA] mb-6 max-w-xs">
        Create your first expense and split the bill instantly using Stellar.
      </p>
      <button
        onClick={onNew}
        className="inline-flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
      >
        <Plus size={15} />
        New Expense
      </button>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ExpensesPage() {
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const { expenses, deleteExpense } = useExpense();
  const [showForm, setShowForm] = useState(false);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        {/* Nav */}
        <nav className="sticky top-0 z-40 flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-white/90 backdrop-blur-xl">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link href="/dashboard" className="flex items-center gap-1.5 text-sm text-[#888] hover:text-[#0F0F14] transition-colors shrink-0">
              <ArrowLeft size={14} />
              <span className="hidden sm:inline">Dashboard</span>
            </Link>
            <span className="text-[#E5E5E5] hidden sm:inline">/</span>
            <span className="text-sm font-bold text-[#0F0F14] truncate">Expenses</span>
          </div>
          <ConnectWalletButton className="shrink-0" />
        </nav>

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          {/* Page header */}
          <div className="flex items-center justify-between gap-3 mb-6">
            <div>
              <h1 className="text-xl font-black text-[#0F0F14]">Expenses</h1>
              <p className="text-sm text-[#888] mt-0.5">
                {expenses.length === 0
                  ? "No expenses yet"
                  : `${expenses.length} expense${expenses.length !== 1 ? "s" : ""}`}
              </p>
            </div>

            {expenses.length > 0 && (
              <button
                onClick={() => setShowForm(true)}
                className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all shrink-0"
              >
                <Plus size={14} />
                New
              </button>
            )}
          </div>

          {/* Expense list or empty state */}
          {expenses.length === 0 ? (
            <EmptyState onNew={() => setShowForm(true)} />
          ) : (
            <div className="space-y-3">
              <AnimatePresence mode="popLayout">
                {expenses.map((expense: Expense) => (
                  <ExpenseCard
                    key={expense.id}
                    expense={expense}
                    onDelete={deleteExpense}
                    currentUserPublicKey={publicKey}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}


        </main>
      </div>

      {/* New Expense modal */}
      <Modal
        open={showForm}
        onClose={() => setShowForm(false)}
        title="New Expense"
        description="Split a bill and track who owes what."
        size="lg"
      >
        <ExpenseForm
          currentUserPublicKey={publicKey}
          currentUserName={user?.displayName}
          onSuccess={() => setShowForm(false)}
          onCancel={() => setShowForm(false)}
        />
      </Modal>
    </AuthGuard>
  );
}
