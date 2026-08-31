"use client";

import React from "react";
import { AlertCircle, Map, ReceiptText, TrendingUp } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { Money as MoneyDisplay } from "@/components/ui/Money";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import { Money } from "@/lib/money";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";

interface DashboardStatsProps {
  expenses: Expense[];
  trips: Trip[];
}

export function DashboardStats({ expenses, trips }: DashboardStatsProps) {
  const settledExpenses = expenses.filter((e) => e.settled).length;
  const settledTrips = trips.filter((t) => t.settled).length;
  const pendingShares = expenses.reduce(
    (acc, e) => acc + (e.shares ?? []).filter((s) => !s.paid).length,
    0,
  );

  const totalsByAsset = expenses.reduce((acc, expense) => {
    // Settlement asset, not the typed-in fiat currency: a EUR expense and a
    // USD expense both settle in XLM and belong in one bucket.
    const asset = settlementAssetOf(expense);
    const amount = Money.tryParse(expense.totalAmount) ?? Money.zero();
    acc[asset] = (acc[asset] ?? Money.zero()).plus(amount);
    return acc;
  }, {} as Record<string, Money>);

  const assetEntries = Object.entries(totalsByAsset);
  let displayValue: React.ReactNode = <MoneyDisplay amount="0" asset="XLM" />;
  let displaySub = "across all bills";

  if (assetEntries.length === 1) {
    const asset = assetEntries[0][0] === "native" ? "XLM" : assetEntries[0][0].split(":")[0];
    displayValue = <MoneyDisplay amount={assetEntries[0][1]} asset={asset} />;
  } else if (assetEntries.length > 1) {
    displayValue = `${assetEntries.length} Assets`;
    displaySub = "multiple assets used";
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <StatCard
        icon={ReceiptText}
        label="Total Expenses"
        value={expenses.length}
        sub={`${settledExpenses} settled`}
      />
      <StatCard
        icon={TrendingUp}
        label={assetEntries.length > 1 ? "Mixed Assets" : "Total Spent"}
        value={displayValue}
        sub={displaySub}
        accent
      />
      <StatCard
        icon={AlertCircle}
        label="Pending Shares"
        value={pendingShares}
        sub="awaiting payment"
      />
      <StatCard
        icon={Map}
        label="Trips"
        value={trips.length}
        sub={`${settledTrips} settled`}
      />
    </div>
  );
}
