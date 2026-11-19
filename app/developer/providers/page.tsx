import React from "react";
import type { Metadata } from "next";
import { ProviderHealthDashboard } from "@/components/developer/ProviderHealthDashboard";

export const metadata: Metadata = {
  title: "Provider Health & Failover Routing | Developer Platform",
  description:
    "Multi-vendor health routing, priority fallback management, and consistency safety controls across Stellar, FX, OCR, and Notification relays.",
};

export default function ProviderHealthPage() {
  return (
    <main className="min-h-screen bg-[#FDFDFD]">
      <ProviderHealthDashboard />
    </main>
  );
}
