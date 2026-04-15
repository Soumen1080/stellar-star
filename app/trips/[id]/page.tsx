"use client";

import React, { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { motion, AnimatePresence } from "framer-motion";
import {
  ArrowLeft,
  ReceiptText,
  Scale,
  Plus,
  Users,
  CheckCheck,
  ExternalLink,
  ChevronRight,
  Inbox,
  CheckCircle2,
} from "lucide-react";
import { useTrip } from "@/hooks/useTrip";
import { useExpense } from "@/hooks/useExpense";
import { usePayment } from "@/hooks/usePayment";
import { useContractEvents } from "@/hooks/useContractEvents";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { Modal } from "@/components/ui/Modal";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { SplitCalculator } from "@/components/expenses/SplitCalculator";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import { PaymentStatus } from "@/components/payment/PaymentStatus";
import { useWallet } from "@/hooks/useWallet";
import { useAuth } from "@/context/AuthContext";
import type { Expense, Member, SplitShare } from "@/types/expense";

type Tab = "expenses" | "settle";

// ─── Expandable Expense Card (with full payment capability) ───────────────────

function TripExpenseCard({
  expense,
  currentUserPublicKey,
  tripId,
}: {
  expense: Expense;
  currentUserPublicKey?: string | null;
  tripId: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const [payingShareId, setPayingShareId] = useState<string | null>(null);
  const { payShare, paymentState, reset, retryOnChainRecord } = usePayment({ expenseId: expense.id });

  const paidCount = expense.shares.filter((s) => s.paid).length;
  const total = parseFloat(expense.totalAmount);
  const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
  const createdAt = new Date(expense.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

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
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      className="bg-white rounded-2xl border border-[#E5E5E5] overflow-hidden hover:border-[#D0D0D0] transition-all"
    >
      {/* Header row — click to expand */}
      <button
        className="w-full flex items-start sm:items-center justify-between gap-3 p-4 text-left"
        onClick={() => setExpanded((v) => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-9 h-9 rounded-xl bg-[#0F0F14] flex items-center justify-center shrink-0">
            <ReceiptText size={15} className="text-[#2DD4BF]" />
          </div>
          <div className="min-w-0">
            <p className="text-sm font-bold text-[#0F0F14] truncate">{expense.title}</p>
            <p className="text-xs text-[#AAA] leading-relaxed">
              {total.toFixed(4)} XLM &middot; {expense.members.length} members &middot; {createdAt}
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

      {/* Progress bar */}
      {expense.shares.length > 0 && (
        <div className="h-0.5 w-full bg-[#F0F0F0]">
          <div
            className="h-full bg-[#2DD4BF] transition-all duration-500"
            style={{ width: `${(paidCount / expense.shares.length) * 100}%` }}
          />
        </div>
      )}

      {/* Expanded — SplitCalculator with Pay buttons */}
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
                <span className="text-[10px] uppercase tracking-wider font-semibold text-[#CCC]">
                  Split: {expense.splitMode}
                </span>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const { getTrip, settleTrip, addExpenseToTrip } = useTrip();
  const { expenses, addExpense } = useExpense();
  const { publicKey } = useWallet();
  const { user } = useAuth();

  const [activeTab, setActiveTab] = useState<Tab>("expenses");
  const [showExpenseForm, setShowExpenseForm] = useState(false);

  const trip = getTrip(params.id);

  const { events: onChainEvents } = useContractEvents(trip?.id);

  // ── Auto-settle trip when ALL linked expenses are paid ─────────────────────
  // Runs whenever any expense changes (e.g. a share gets marked paid).
  // Once every expense in this trip is settled, settleTrip is called automatically.
  useEffect(() => {
    if (!trip || trip.settled) return;
    const linked = expenses.filter((e) => trip.expenseIds.includes(e.id));
    if (linked.length > 0 && linked.every((e) => e.settled)) {
      settleTrip(trip.id);
    }
  }, [expenses, trip, settleTrip]);

  // Trip not found
  if (!trip) {
    return (
      <AuthGuard>
        <div className="min-h-screen bg-[#F6F6F6] flex flex-col items-center justify-center gap-4">
          <p className="text-[#888]">Trip not found.</p>
          <Link
            href="/trips"
            className="text-sm font-semibold text-[#0F0F14] underline"
          >
            Back to Trips
          </Link>
        </div>
      </AuthGuard>
    );
  }

  const tripExpenses = expenses.filter((e) => trip.expenseIds.includes(e.id));
  const totalXLM = tripExpenses.reduce(
    (sum, e) => sum + parseFloat(e.totalAmount),
    0
  );
  const paidShares = tripExpenses.flatMap((e) => e.shares).filter((s) => s.paid).length;
  const totalShares = tripExpenses.flatMap((e) => e.shares).length;

  // Per-member settlement: find all shares belonging to the connected wallet
  const myShares = tripExpenses.flatMap((e) =>
    e.shares.filter((s) => s.walletAddress === publicKey)
  );
  const myPaidShares = myShares.filter((s) => s.paid);
  const myFullySettled = myShares.length > 0 && myShares.every((s) => s.paid);

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        {/* Nav */}
        <nav className="sticky top-0 z-40 flex items-center justify-between gap-2 px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-white/90 backdrop-blur-xl">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <Link
              href="/trips"
              className="flex items-center gap-1.5 text-sm text-[#888] hover:text-[#0F0F14] transition-colors shrink-0"
            >
              <ArrowLeft size={14} />
              <span className="hidden sm:inline">Trips</span>
            </Link>
            <span className="text-[#E5E5E5] hidden sm:inline">/</span>
            <span className="text-sm font-bold text-[#0F0F14] max-w-[120px] sm:max-w-[220px] truncate">
              {trip.name}
            </span>
          </div>
          <ConnectWalletButton className="shrink-0" />
        </nav>

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          {/* Trip header */}
          <div className="bg-white rounded-2xl border border-[#E5E5E5] p-5 mb-6">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="flex items-center gap-2 mb-1">
                  <h1 className="text-lg font-black text-[#0F0F14]">{trip.name}</h1>
                  {trip.settled && (
                    <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                      <CheckCheck size={9} />
                      Settled
                    </span>
                  )}
                </div>
                {trip.description && (
                  <p className="text-sm text-[#888] mb-3">{trip.description}</p>
                )}
                <div className="flex flex-wrap gap-4 text-xs text-[#AAA]">
                  <span className="flex items-center gap-1">
                    <Users size={11} />
                    {trip.members.length} members
                  </span>
                  <span className="flex items-center gap-1">
                    <ReceiptText size={11} />
                    {tripExpenses.length} expense{tripExpenses.length !== 1 ? "s" : ""}
                  </span>
                  {totalXLM > 0 && (
                    <span className="font-semibold text-[#555]">
                      {totalXLM.toFixed(4)} XLM total
                    </span>
                  )}
                  {totalShares > 0 && (
                    <span className="text-[#134E4A]">
                      {paidShares}/{totalShares} shares paid
                    </span>
                  )}
                </div>
              </div>


            </div>

            {/* Members row */}
            <div className="mt-4 pt-4 border-t border-[#F5F5F5]">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-[#AAA] mb-2">
                Members
              </p>
              <div className="flex flex-wrap gap-2">
                {trip.members.map((m: Member) => (
                  <div
                    key={m.id}
                    className="flex items-center gap-1.5 px-2.5 py-1 bg-[#F6F6F6] rounded-lg border border-[#EBEBEB]"
                  >
                    <div className="w-5 h-5 rounded-full bg-[#0F0F14] flex items-center justify-center text-[9px] font-bold text-[#2DD4BF]">
                      {m.name.charAt(0).toUpperCase()}
                    </div>
                    <span className="text-xs font-medium text-[#555]">{m.name}</span>
                    {m.walletAddress && (
                      <a
                        href={`https://stellar.expert/explorer/testnet/account/${m.walletAddress}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#CCC] hover:text-[#888]"
                      >
                        <ExternalLink size={9} />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Tabs */}
          {/* Per-member settlement banner — visible to the connected user */}
          {publicKey && myShares.length > 0 && (
            <div
              className={`flex items-center gap-3 px-4 py-3 rounded-xl border mb-4 ${
                myFullySettled
                  ? "bg-[#F0FFDB] border-[#2DD4BF]/50"
                  : "bg-white border-[#E5E5E5]"
              }`}
            >
              <CheckCircle2
                size={18}
                className={myFullySettled ? "text-[#134E4A] shrink-0" : "text-[#CCC] shrink-0"}
              />
              <div className="flex-1 min-w-0">
                {myFullySettled ? (
                  <>
                    <p className="text-sm font-bold text-[#134E4A]">Your part is fully settled!</p>
                    <p className="text-xs text-[#5a9400]">
                      You paid all {myShares.length} of your share{myShares.length !== 1 ? "s" : ""} in this trip.
                    </p>
                  </>
                ) : (
                  <>
                    <p className="text-sm font-bold text-[#0F0F14]">Your payment progress</p>
                    <p className="text-xs text-[#888]">
                      {myPaidShares.length} of {myShares.length} share{myShares.length !== 1 ? "s" : ""} paid
                    </p>
                  </>
                )}
              </div>
              {!myFullySettled && (
                <span className="text-xs font-bold text-[#888] shrink-0">
                  {myShares.length - myPaidShares.length} remaining
                </span>
              )}
            </div>
          )}

          <div className="flex gap-1 p-1 bg-[#EBEBEB] rounded-xl mb-5">
            {(["expenses", "settle"] as Tab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`flex-1 flex items-center justify-center gap-1 sm:gap-1.5 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
                  activeTab === tab
                    ? "bg-white text-[#0F0F14] shadow-sm"
                    : "text-[#888] hover:text-[#0F0F14]"
                }`}
              >
                {tab === "expenses" ? (
                  <>
                    <ReceiptText size={13} />
                    Expenses
                  </>
                ) : (
                  <>
                    <Scale size={13} />
                    Settle Up
                  </>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <AnimatePresence mode="wait">
            {activeTab === "expenses" ? (
              <motion.div
                key="expenses"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-sm font-bold text-[#0F0F14]">
                    Expenses ({tripExpenses.length})
                  </h2>
                  <button
                    onClick={() => setShowExpenseForm(true)}
                    className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-[#0F0F14] text-[#2DD4BF] hover:bg-[#1A1A22] transition-all"
                  >
                    <Plus size={12} />
                    Add Expense
                  </button>
                </div>
                {tripExpenses.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-10 px-4 text-center rounded-xl border border-dashed border-[#E5E5E5]">
                    <ReceiptText size={20} className="text-[#CCC] mb-2" />
                    <p className="text-sm text-[#AAA]">No expenses in this trip yet.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    <AnimatePresence mode="popLayout">
                      {tripExpenses.map((expense: Expense) => (
                        <TripExpenseCard
                          key={expense.id}
                          expense={expense}
                          currentUserPublicKey={publicKey}
                          tripId={trip.id}
                        />
                      ))}
                    </AnimatePresence>
                  </div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="settle"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15 }}
              >
                <SettlementSummary trip={trip} expenses={tripExpenses} onChainEvents={onChainEvents} />
              </motion.div>
            )}
          </AnimatePresence>
        </main>
      </div>

      {/* Add Expense modal — pre-populates with trip members */}
      <Modal
        open={showExpenseForm}
        onClose={() => setShowExpenseForm(false)}
        title="Add Expense"
        description={`Add an expense to "${trip.name}"`}
        size="lg"
      >
        <ExpenseForm
          currentUserPublicKey={publicKey}
          currentUserName={user?.displayName}
          defaultMembers={trip.members}
          onSuccess={(newExpenseId?: string) => {
            if (newExpenseId) addExpenseToTrip(trip.id, newExpenseId);
            setShowExpenseForm(false);
          }}
          onCancel={() => setShowExpenseForm(false)}
        />
      </Modal>
    </AuthGuard>
  );
}
