import React from "react";
import type { Metadata } from "next";
import Header from "@/components/layout/Header";
import { SupportConsole } from "@/components/support/SupportConsole";

export const metadata: Metadata = {
  title: "Incident-Response & Support Console | StellarStar",
  description:
    "Read-only payment incident diagnostics, cryptographic timeline verification, and audited dual-control resolution.",
};

export default function SupportPage() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] text-[#0F0F14]">
      <Header />
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-24 pb-16">
        <SupportConsole />
      </main>
    </div>
  );
}
