"use client";

import { AlertCircle, Map, ReceiptText, TrendingUp } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
import { Money } from "@/components/ui/Money";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

interface DashboardStatsProps {
  expenses: Expense[];
  trips: Trip[];
}

export function DashboardStats({ expenses, trips }: DashboardStatsProps) {
  const settledExpenses = expenses.filter((e) => e.settled).length;
  const settledTrips = trips.filter((t) => t.settled).length;

  const totalsByAsset = expenses.reduce((acc, expense) => {
    const asset = expense.currency || "XLM";
    acc[asset] = (acc[acc[asset] ? asset : (expense.currency || "XLM")] || 0) + parseFloat(expense.totalAmount);
    return acc;
  }, {} as Record<string, number>);

  const assetEntries = Object.entries(totalsByAsset);
  let displayValue: React.ReactNode = <Money amount={0} asset="XLM" />;
  let displayAsset = "XLM";
  let displaySub = "across all bills";

  if (assetEntries.length === 1) {
    const [asset, amount] = assetEntries[0];
    displayAsset = asset === "native" ? "XLM" : asset.split(":")[0];
    displayValue = <Money amount={amount} asset={displayAsset} />;
  } else if (assetEntries.length > 1) {
    displayValue = `${assetEntries.length} Assets`;
    displaySub = "multiple assets used";
  }

  const pendingShares = expenses.reduce(
    (sum, e) => sum + (e.shares ? e.shares.filter((s) => !s.paid).length : 0),
    0
  );

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <StatCard icon={ReceiptText} label="Total Expenses" value={expenses.length} sub={`${settledExpenses} settled`} />
      <StatCard icon={TrendingUp} label={assetEntries.length > 1 ? "Mixed Assets" : `Total Spent`} value={displayValue} sub={displaySub} accent />
      <StatCard icon={AlertCircle} label="Pending Shares" value={pendingShares} sub="awaiting payment" />
      <StatCard icon={Map} label="Trips" value={trips.length} sub={`${settledTrips} settled`} />
    </div>
  );
}
