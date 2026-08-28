"use client";

import Link from "next/link";
import { ArrowRight, CheckCircle2, ReceiptText } from "lucide-react";
import type { Expense } from "@/types/expense";

export function RecentExpenseRow({ expense }: { expense: Expense }) {
  const paidCount = expense.shares.filter((share) => share.paid).length;
  const total = parseFloat(expense.totalAmount);
  const allPaid = paidCount === expense.shares.length && expense.shares.length > 0;
  const date = new Date(expense.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
  const fiatAmount =
    expense.currency !== "XLM" && expense.exchangeRate
      ? (parseFloat(expense.totalAmount) / parseFloat(expense.exchangeRate)).toFixed(2)
      : null;

  return (
    <Link
      href="/expenses"
      className="flex items-center gap-3 p-3 rounded-xl hover:bg-[#F6F6F6] transition-colors group"
    >
      <div
        className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
          allPaid ? "bg-[#2DD4BF]/20" : "bg-[#0F0F14]"
        }`}
      >
        <ReceiptText size={13} className={allPaid ? "text-[#134E4A]" : "text-[#2DD4BF]"} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#0F0F14] truncate">{expense.title}</p>
        <p className="text-[11px] text-[#AAA]">
          {total.toFixed(4)} XLM{fiatAmount ? ` (~${fiatAmount} ${expense.currency})` : ""} &middot; {expense.members.length} members &middot; {date}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {allPaid ? (
          <CheckCircle2 size={14} className="text-[#134E4A]" />
        ) : (
          <span className="text-[11px] font-semibold text-[#888]">
            {paidCount}/{expense.shares.length}
          </span>
        )}
        <ArrowRight size={12} className="text-[#D0D0D0] group-hover:text-[#888] transition-colors" />
      </div>
    </Link>
  );
}
