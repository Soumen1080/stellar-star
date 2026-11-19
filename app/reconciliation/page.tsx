import React from "react";
import type { Metadata } from "next";
import Header from "@/components/layout/Header";
import { ReconciliationDashboard } from "@/components/reconciliation/ReconciliationDashboard";

export const metadata: Metadata = {
  title: "On-Chain Reconciliation Console | StellarStar",
  description:
    "Automated server-side verification worker, durable backoff queue, and anti-ambiguity settlement escalation console.",
};

export default function ReconciliationPage() {
  return (
    <div className="min-h-screen bg-[#FDFDFD] text-[#0F0F14]">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-16">
        <ReconciliationDashboard />
      </main>
    </div>
  );
}
