"use client";

import { motion } from "framer-motion";
import { Plus, ReceiptText } from "lucide-react";
import { ExpenseHistoryList } from "@/components/expenses/ExpenseHistoryList";
import type { Expense, Member } from "@/types/expense";

interface TripExpensesPanelProps {
  expenses: Expense[];
  tripId: string;
  /** Trip members, offered as payers in the history filters. */
  members?: Member[];
  currentUserPublicKey?: string | null;
  /** Omitted when the trip's permissions do not let this viewer add expenses. */
  onAddExpense?: () => void;
}

export function TripExpensesPanel({
  expenses,
  tripId,
  members,
  currentUserPublicKey,
  onAddExpense,
}: TripExpensesPanelProps) {
  return (
    <motion.div
      key="expenses"
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -8 }}
      transition={{ duration: 0.15 }}
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-[#0F0F14]">Expenses ({expenses.length})</h2>
        {onAddExpense ? (
          <button
            onClick={onAddExpense}
            className="flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-xl bg-[#0F0F14] text-[#2DD4BF] hover:bg-[#1A1A22] transition-all"
          >
            <Plus size={12} />
            Add Expense
          </button>
        ) : (
          <span className="text-[11px] text-[#AAA]">Only the trip creator can add expenses</span>
        )}
      </div>
      {expenses.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-10 px-4 text-center rounded-xl border border-dashed border-[#E5E5E5]">
          <ReceiptText size={20} className="text-[#CCC] mb-2" />
          <p className="text-sm text-[#AAA]">No expenses in this trip yet.</p>
        </div>
      ) : (
        <ExpenseHistoryList
          expenses={expenses}
          tripId={tripId}
          members={members}
          currentUserPublicKey={currentUserPublicKey}
        />
      )}
    </motion.div>
  );
}
