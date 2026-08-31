"use client";

import { CheckCheck, ReceiptText, Users } from "lucide-react";
import { TripMembersList } from "@/components/trips/TripMembersList";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

import { Money as MoneyDisplay } from "@/components/ui/Money";
import { Money } from "@/lib/money";

interface TripDetailHeaderProps {
  trip: Trip;
  expenses: Expense[];
}

export function TripDetailHeader({ trip, expenses }: TripDetailHeaderProps) {
  const totalsByAsset = expenses.reduce((acc, expense) => {
    const asset = expense.currency || "XLM";
    const amount = Money.tryParse(expense.totalAmount) ?? Money.zero();
    acc[asset] = (acc[asset] ?? Money.zero()).plus(amount);
    return acc;
  }, {} as Record<string, Money>);

  const shares = expenses.flatMap((expense) => expense.shares);
  const paidShares = shares.filter((share) => share.paid).length;

  const assetEntries = Object.entries(totalsByAsset);
  let displayTotal: React.ReactNode = null;
  if (assetEntries.length === 1) {
    const asset = assetEntries[0][0] === "native" ? "XLM" : assetEntries[0][0].split(":")[0];
    displayTotal = (
      <>
        <MoneyDisplay amount={assetEntries[0][1]} asset={asset} />
        <span> total</span>
      </>
    );
  } else if (assetEntries.length > 1) {
    displayTotal = "Mixed Assets total";
  }

  return (
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
          {trip.description && <p className="text-sm text-[#888] mb-3">{trip.description}</p>}
          <div className="flex flex-wrap gap-4 text-xs text-[#AAA]">
            <span className="flex items-center gap-1">
              <Users size={11} />
              {trip.members.length} members
            </span>
            <span className="flex items-center gap-1">
              <ReceiptText size={11} />
              {expenses.length} expense{expenses.length !== 1 ? "s" : ""}
            </span>
            {displayTotal && (
              <span className="font-semibold text-[#555]">{displayTotal}</span>
            )}
            {shares.length > 0 && (
              <span className="text-[#134E4A]">
                {paidShares}/{shares.length} shares paid
              </span>
            )}
          </div>
        </div>
      </div>

      <TripMembersList members={trip.members} />
    </div>
  );
}
