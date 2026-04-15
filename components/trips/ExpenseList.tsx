"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ReceiptText, Inbox } from "lucide-react";
import type { Expense } from "@/types/expense";
import { cn } from "@/lib/utils";

interface ExpenseListProps {
  expenses: Expense[];
  onSelect?: (expense: Expense) => void;
}

export function ExpenseList({ expenses, onSelect }: ExpenseListProps) {
  if (expenses.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-10 px-4 text-center rounded-xl border border-dashed border-[#E5E5E5]">
        <Inbox size={20} className="text-[#CCC] mb-2" />
        <p className="text-sm text-[#AAA]">No expenses in this trip yet.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <AnimatePresence mode="popLayout">
        {expenses.map((expense, i) => {
          const paidCount = expense.shares.filter((s) => s.paid).length;
          const total = parseFloat(expense.totalAmount);
          const createdAt = new Date(expense.createdAt).toLocaleDateString("en-US", {
            month: "short",
            day: "numeric",
          });

          return (
            <motion.div
              key={expense.id}
              layout
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97 }}
              transition={{ delay: i * 0.04 }}
            >
              <button
                onClick={() => onSelect?.(expense)}
                className={cn(
                  "w-full flex items-center justify-between gap-3 p-3.5 rounded-xl border text-left transition-all",
                  expense.settled
                    ? "bg-[#F0FFDB] border-[#2DD4BF]/40"
                    : "bg-white border-[#E5E5E5] hover:border-[#D0D0D0] hover:shadow-sm"
                )}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-[#0F0F14] flex items-center justify-center shrink-0">
                    <ReceiptText size={13} className="text-[#2DD4BF]" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-[#0F0F14] truncate">
                      {expense.title}
                    </p>
                    <p className="text-[11px] text-[#AAA]">
                      {total.toFixed(4)} XLM &middot; {createdAt}
                    </p>
                  </div>
                </div>

                <div className="shrink-0 text-right">
                  {expense.settled ? (
                    <span className="text-[10px] font-bold uppercase px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                      Settled
                    </span>
                  ) : (
                    <span className="text-xs text-[#AAA]">
                      {paidCount}/{expense.shares.length} paid
                    </span>
                  )}
                </div>
              </button>

              {/* Progress bar */}
              {expense.shares.length > 0 && (
                <div className="-mt-0.5 h-0.5 w-full bg-[#F0F0F0] rounded-b-xl overflow-hidden">
                  <div
                    className="h-full bg-[#2DD4BF] transition-all duration-500"
                    style={{
                      width: `${(paidCount / expense.shares.length) * 100}%`,
                    }}
                  />
                </div>
              )}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
