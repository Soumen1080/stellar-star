"use client";

import { Repeat, ReceiptText, Scale, Luggage, CheckSquare } from "lucide-react";
import { useLocale } from "@/context/LocaleContext";

export type TripTab = "expenses" | "workspace" | "recurring" | "chores" | "settle";

interface TripTabsProps {
  activeTab: TripTab;
  onChange: (tab: TripTab) => void;
}

export function TripTabs({ activeTab, onChange }: TripTabsProps) {
  const { t } = useLocale();

  return (
    <div className="flex gap-1 p-1 bg-[#EBEBEB] rounded-xl mb-5">
      {(["expenses", "workspace", "recurring", "chores", "settle"] as TripTab[]).map((tab) => (
        <button
          key={tab}
          type="button"
          aria-pressed={activeTab === tab}
          onClick={() => onChange(tab)}
          className={`flex-1 flex items-center justify-center gap-1 sm:gap-1.5 py-2.5 rounded-lg text-xs sm:text-sm font-semibold transition-all ${
            activeTab === tab
              ? "bg-white text-[#0F0F14] shadow-sm"
              : "text-[#888] hover:text-[#0F0F14]"
          }`}
        >
          {tab === "expenses" ? (
            <>
              <ReceiptText size={13} />
              {t("trips.tabExpenses")}
            </>
          ) : tab === "workspace" ? (
            <>
              <Luggage size={13} />
              {t("trips.tabWorkspace")}
            </>
          ) : tab === "recurring" ? (
            <>
              <Repeat size={13} />
              {t("trips.tabRecurring")}
            </>
          ) : tab === "chores" ? (
            <>
              <CheckSquare size={13} />
              {t("trips.tabChores")}
            </>
          ) : (
            <>
              <Scale size={13} />
              {t("trips.tabSettle")}
            </>
          )}
        </button>
      ))}
    </div>
  );
}
