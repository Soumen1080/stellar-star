"use client";

import React, { useState, useEffect } from "react";
import { Compass, ArrowRight, X, Sparkles } from "lucide-react";
import { GuidedOnboardingModal, type OnboardingMode } from "./GuidedOnboardingModal";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

interface GuidedOnboardingBannerProps {
  mode: OnboardingMode;
  tripId?: string;
}

export function GuidedOnboardingBanner({ mode, tripId }: GuidedOnboardingBannerProps) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDismissed, setIsDismissed] = useState(true); // Default true until checked in effect

  useEffect(() => {
    try {
      const dismissed = localStorage.getItem(`stellar_star_onboarding_${mode}_dismissed`);
      setIsDismissed(dismissed === "true");
    } catch {
      setIsDismissed(false);
    }
  }, [mode]);

  const handleDismiss = () => {
    setIsDismissed(true);
    trackAnalyticsEvent("onboarding_abandoned", {
      mode,
      last_step_index: 0,
    });
    try {
      localStorage.setItem(`stellar_star_onboarding_${mode}_dismissed`, "true");
    } catch {
      // Storage unavailable
    }
  };

  const handleOpen = () => {
    setIsModalOpen(true);
  };

  const getBannerCopy = () => {
    switch (mode) {
      case "create":
        return {
          title: "New trip setup guide",
          desc: "Learn the 3 quick steps to organize members, expenses, and currencies.",
        };
      case "join":
        return {
          title: "First time on this trip?",
          desc: "Follow the 3-step guide to connect your wallet, check readiness, and settle expenses.",
        };
      case "view":
      default:
        return {
          title: "Viewing this trip",
          desc: "Discover how transparent balances work and how to join if you want to split costs.",
        };
    }
  };

  const copy = getBannerCopy();

  return (
    <>
      {!isDismissed ? (
        <div
          role="region"
          aria-label="Trip onboarding banner"
          className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-2xl border border-teal-200/70 bg-gradient-to-r from-teal-50/90 via-white to-teal-50/50 p-4 shadow-sm"
        >
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#2DD4BF]/20 text-[#0F766E]">
              <Sparkles size={18} />
            </span>
            <div>
              <h4 className="text-sm font-bold text-neutral-900">{copy.title}</h4>
              <p className="text-xs text-neutral-600">{copy.desc}</p>
            </div>
          </div>

          <div className="flex items-center gap-2 self-end sm:self-center">
            <button
              type="button"
              onClick={handleOpen}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0F766E] px-3.5 py-1.5 text-xs font-bold text-white shadow-sm hover:bg-[#115E59] focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] transition-colors"
            >
              Start guide
              <ArrowRight size={13} />
            </button>
            <button
              type="button"
              onClick={handleDismiss}
              aria-label="Dismiss onboarding banner"
              className="rounded-lg p-1 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] transition-colors"
            >
              <X size={16} />
            </button>
          </div>
        </div>
      ) : (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            onClick={handleOpen}
            className="inline-flex items-center gap-1.5 rounded-full border border-neutral-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-neutral-600 shadow-sm hover:bg-neutral-50 hover:text-neutral-900 focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] transition-all"
          >
            <Compass size={13} className="text-[#0F766E]" />
            Onboarding guide
          </button>
        </div>
      )}

      <GuidedOnboardingModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        mode={mode}
        onComplete={() => setIsDismissed(true)}
      />
    </>
  );
}
