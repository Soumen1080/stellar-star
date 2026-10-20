"use client";

import React from "react";
import { ShieldCheck, X } from "lucide-react";
import { useAnalytics } from "@/context/AnalyticsContext";

export function ConsentBanner() {
  const { isConsentBannerOpen, updateConsent, openConsentModal, closeConsentBanner } = useAnalytics();

  if (!isConsentBannerOpen) return null;

  return (
    <div
      role="region"
      aria-label="Analytics Consent"
      className="fixed bottom-4 left-4 right-4 sm:left-auto sm:right-6 sm:max-w-md z-50 bg-[#0F0F14] text-white p-5 rounded-2xl shadow-2xl border border-white/10 backdrop-blur-xl animate-in fade-in slide-in-from-bottom-5 duration-300"
    >
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-xl bg-[#2DD4BF]/20 flex items-center justify-center shrink-0 mt-0.5">
          <ShieldCheck size={18} className="text-[#2DD4BF]" />
        </div>
        <div className="flex-1 min-w-0">
          <h4 className="text-sm font-bold text-white mb-1">Privacy-First Product Analytics</h4>
          <p className="text-xs text-[#AAA] leading-relaxed mb-4">
            We collect non-sensitive metrics (such as wallet compatibility and onboarding failures) to improve the product.
            We <strong className="text-white">never</strong> collect wallet addresses, private keys, transaction XDR, or descriptions.
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={() => updateConsent(true)}
              className="px-3.5 py-1.5 bg-[#2DD4BF] text-[#0F0F14] text-xs font-bold rounded-lg hover:bg-[#2DD4BF]/90 transition-all"
            >
              Accept Analytics
            </button>
            <button
              onClick={() => updateConsent(false)}
              className="px-3.5 py-1.5 bg-white/10 text-white text-xs font-semibold rounded-lg hover:bg-white/15 transition-all"
            >
              Decline
            </button>
            <button
              onClick={openConsentModal}
              className="px-2 py-1.5 text-xs text-[#2DD4BF] hover:underline transition-all"
            >
              Learn More
            </button>
          </div>
        </div>
        <button
          onClick={closeConsentBanner}
          className="text-[#666] hover:text-white transition-colors"
          aria-label="Dismiss banner"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
