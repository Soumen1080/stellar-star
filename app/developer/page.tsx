import React from "react";
import type { Metadata } from "next";
import { DeveloperPortal } from "@/components/developer/DeveloperPortal";

export const metadata: Metadata = {
  title: "Developer Platform & API | StellarStar",
  description:
    "Versioned API, scoped tokens, webhooks, and OpenAPI specification for accounting and ERP integrations.",
};

export default function DeveloperPage() {
  return (
    <main className="min-h-screen bg-[#FDFDFD]">
      <DeveloperPortal />
    </main>
  );
}
