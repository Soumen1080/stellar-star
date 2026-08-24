"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence } from "framer-motion";
import { ArrowLeft, Plus } from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { ExpenseCard } from "@/components/expenses/ExpenseCard";
import { ExpenseEmptyState } from "@/components/expenses/ExpenseEmptyState";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthContext";
import { useExpense } from "@/hooks/useExpense";
import { useWallet } from "@/hooks/useWallet";
import type { Expense } from "@/types/expense";

export default function ExpensesPage() {
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const { expenses, deleteExpense, isLoading, isOffline } = useExpense();
  const [showForm, setShowForm] = useState(false);
  const { success: toastSuccess, error: toastError } = useToast();

  // Deletes now reject rather than failing silently, so the outcome has to be
  // reported: an expense that looks deleted but is still in the database is
  // worse than an error message.
  const handleDeleteExpense = async (id: string) => {
    try {
      await deleteExpense(id);
      toastSuccess("Expense deleted");
    } catch (err: any) {
      const message = String(err?.message ?? "");
      const isPermissionDenied =
        err?.code === "42501" ||
        /permission|policy|row-level security/i.test(message);
      toastError(
        "Failed to delete expense",
        isPermissionDenied
          ? "Only the person who created this expense can delete it."
          : message || "Could not delete this expense. Please try again."
      );
    }
  };

  return (
    <AuthGuard>
      <div className="min-h-screen bg-[#F6F6F6]">
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

          {isOffline && (
            <div className="mb-6 p-3 bg-yellow-50 border border-yellow-200 rounded-xl text-sm text-yellow-800">
              You are currently viewing offline data. Some features may be unavailable.
            </div>
          )}

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size={32} className="text-[#2DD4BF]" />
            </div>
          ) : expenses.length === 0 ? (
            <ExpenseEmptyState onNew={() => setShowForm(true)} />
          ) : (
            <div className="space-y-3">
              <AnimatePresence mode="popLayout">
                {expenses.map((expense: Expense) => (
                  <ExpenseCard
                    key={expense.id}
                    expense={expense}
                    onDelete={handleDeleteExpense}
                    currentUserPublicKey={publicKey}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}
        </main>
      </div>

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
