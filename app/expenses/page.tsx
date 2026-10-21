"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowLeft, Plus } from "lucide-react";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { ExpenseEmptyState } from "@/components/expenses/ExpenseEmptyState";
import { ExpenseForm } from "@/components/expenses/ExpenseForm";
import { ExpenseHistoryList } from "@/components/expenses/ExpenseHistoryList";
import { Modal } from "@/components/ui/Modal";
import { Spinner } from "@/components/ui/Spinner";
import { useToast } from "@/components/ui/Toast";
import { useAuth } from "@/context/AuthContext";
import { useExpense } from "@/hooks/useExpense";
import { useWallet } from "@/hooks/useWallet";

export default function ExpensesPage() {
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const { expenses, deleteExpense, isLoading, isOffline, expenseDrafts, syncExpenseDrafts, discardExpenseDraft } = useExpense();
  const pendingExpenseDrafts = expenseDrafts ?? [];
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

          {pendingExpenseDrafts.length > 0 && <section aria-label="Queued expense drafts" className="mb-6 rounded-xl border border-amber-200 bg-amber-50 p-4">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div><h2 className="font-semibold text-amber-950">Expense drafts awaiting sync</h2><p className="text-xs text-amber-800">Drafts are not shared until the server accepts them. Payment and settlement still require a connection.</p></div>
              <button type="button" onClick={() => void syncExpenseDrafts()} disabled={isOffline} className="min-h-11 rounded-lg bg-amber-900 px-3 text-sm font-semibold text-white disabled:opacity-50">Sync now</button>
            </div>
            <ul className="space-y-2">{pendingExpenseDrafts.map((draft) => <li key={draft.idempotencyKey} className="flex items-start justify-between gap-3 rounded-lg bg-white/80 p-3 text-sm">
              <div><p className="font-medium text-[#0F0F14]">{draft.expense.title}</p><p className={draft.status === "conflict" ? "text-red-700" : "text-amber-800"}>{draft.status === "conflict" ? `Conflict: ${draft.message || "Review required."}` : "Queued · waiting for connection"}</p></div>
              {draft.status === "conflict" && <button type="button" onClick={() => discardExpenseDraft(draft.idempotencyKey)} className="min-h-11 shrink-0 px-2 text-red-700 underline">Discard draft</button>}
            </li>)}</ul>
          </section>}

          {isLoading ? (
            <div className="flex justify-center py-12">
              <Spinner size={32} className="text-[#2DD4BF]" />
            </div>
          ) : expenses.length === 0 ? (
            <ExpenseEmptyState onNew={() => setShowForm(true)} />
          ) : (
            <ExpenseHistoryList
              expenses={expenses}
              onDelete={handleDeleteExpense}
              currentUserPublicKey={publicKey}
            />
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
