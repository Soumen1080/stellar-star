"use client";

import React from "react";
import Header from "@/components/layout/Header";
import { AnalyticsDashboard } from "@/components/analytics/AnalyticsDashboard";
import { ConsentBanner } from "@/components/analytics/ConsentBanner";
import { ConsentModal } from "@/components/analytics/ConsentModal";

export default function AnalyticsPage() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] text-[#0F0F14]">
      <Header />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-16">
        <AnalyticsDashboard />
      </main>
      <ConsentBanner />
      <ConsentModal />
    </div>
  );
}
