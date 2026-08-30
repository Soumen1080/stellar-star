"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { useParams } from "next/navigation";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { Modal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";
import { SettlementSummary } from "@/components/trips/SettlementSummary";
import { TripDetailHeader } from "@/components/trips/TripDetailHeader";
import { TripDetailNav } from "@/components/trips/TripDetailNav";
import { TripExpensesPanel } from "@/components/trips/TripExpensesPanel";
import { TripNotFound } from "@/components/trips/TripNotFound";
import { TripPaymentProgressBanner } from "@/components/trips/TripPaymentProgressBanner";
import { TripTabs, type TripTab } from "@/components/trips/TripTabs";
import { useAuth } from "@/context/AuthContext";
import { useContractEvents } from "@/hooks/useContractEvents";
import { useExpense } from "@/hooks/useExpense";
import { useTrip } from "@/hooks/useTrip";
import { useTripAutoSettlement } from "@/hooks/useTripAutoSettlement";
import { useWallet } from "@/hooks/useWallet";
import { Spinner } from "@/components/ui/Spinner";

export default function TripDetailPage() {
  const params = useParams<{ id: string }>();
  const { getTrip, settleTrip, addExpenseToTrip, isLoading } = useTrip();
  const { expenses } = useExpense();
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const [activeTab, setActiveTab] = useState<TripTab>("expenses");
  const [showExpenseForm, setShowExpenseForm] = useState(false);
  const { error: toastError } = useToast();

  // The expense itself saved successfully; only the link to this trip failed.
  // Say so plainly rather than letting the promise reject unhandled.
  const linkExpenseToTrip = (tripId: string, expenseId: string) => {
    void addExpenseToTrip(tripId, expenseId).catch((err: any) => {
      toastError(
        "Expense saved, but not added to this trip",
        err?.message || "Reload the page and add it to the trip again."
      );
    });
  };

  const trip = getTrip(params.id);
  const tripExpenses = trip ? expenses.filter((expense) => trip.expenseIds.includes(expense.id)) : [];
  const myShares = tripExpenses.flatMap((expense) =>
    expense.shares.filter((share) => share.walletAddress === publicKey)
  );
  const { events: onChainEvents } = useContractEvents(trip?.id, tripExpenses);

  useTripAutoSettlement(trip, expenses, settleTrip);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
        <Spinner size={32} className="text-[#2DD4BF]" />
      </div>
    );
  }

  if (!trip) {
    return <TripNotFound />;
  }

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
        <TripDetailNav tripName={trip.name} />

        <main className="max-w-2xl mx-auto px-4 sm:px-6 py-8">
          <TripDetailHeader trip={trip} expenses={tripExpenses} />
          {publicKey && <TripPaymentProgressBanner shares={myShares} />}
          <TripTabs activeTab={activeTab} onChange={setActiveTab} />

          <AnimatePresence mode="wait">
            {activeTab === "expenses" ? (
              <TripExpensesPanel
                expenses={tripExpenses}
                tripId={trip.id}
                currentUserPublicKey={publicKey}
                onAddExpense={() => setShowExpenseForm(true)}
              />
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
            if (newExpenseId) linkExpenseToTrip(trip.id, newExpenseId);
            setShowExpenseForm(false);
          }}
          onCancel={() => setShowExpenseForm(false)}
        />
      </Modal>
    </AuthGuard>
  );
}
