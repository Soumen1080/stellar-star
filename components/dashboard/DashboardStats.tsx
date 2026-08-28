"use client";

import { AlertCircle, Map, ReceiptText, TrendingUp } from "lucide-react";
import { StatCard } from "@/components/dashboard/StatCard";
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
    acc[asset] = (acc[asset] || 0) + parseFloat(expense.totalAmount);
    return acc;
  }, {} as Record<string, number>);

  const assetEntries = Object.entries(totalsByAsset);
  // Default to XLM if nothing exists, otherwise pick the first or show "Mixed"
  let displayTotal = "0.00";
  let displayAsset = "XLM";
  let displaySub = "across all bills";

  if (assetEntries.length === 1) {
    displayTotal = assetEntries[0][1].toFixed(2);
    displayAsset = assetEntries[0][0] === "native" ? "XLM" : assetEntries[0][0].split(":")[0];
  } else if (assetEntries.length > 1) {
    displayTotal = expenses.length.toString();
    displayAsset = "Mixed";
    displaySub = "multiple assets used";
  }

  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
      <StatCard icon={ReceiptText} label="Total Expenses" value={expenses.length} sub={`${settledExpenses} settled`} />
      <StatCard icon={TrendingUp} label={assetEntries.length > 1 ? "Mixed Assets" : `Total ${displayAsset} Spent`} value={assetEntries.length > 1 ? `${assetEntries.length} Assets` : displayTotal} sub={displaySub} accent />
      <StatCard icon={AlertCircle} label="Pending Shares" value={pendingShares} sub="awaiting payment" />
      <StatCard icon={Map} label="Trips" value={trips.length} sub={`${settledTrips} settled`} />
    </div>
  );
}
