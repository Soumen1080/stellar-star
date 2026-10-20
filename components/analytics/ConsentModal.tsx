"use client";

import React from "react";
import { Modal } from "@/components/ui/Modal";
import { Shield, Check, X, Lock, EyeOff, Globe } from "lucide-react";
import { useAnalytics } from "@/context/AnalyticsContext";
import { EVENT_TAXONOMY } from "@/lib/analytics/taxonomy";

export function ConsentModal() {
  const { isConsentModalOpen, closeConsentModal, consent, updateConsent } = useAnalytics();

  if (!isConsentModalOpen) return null;

  const isGranted = consent.status === "granted";

  return (
    <Modal open={isConsentModalOpen} onClose={closeConsentModal} title="Privacy & Analytics Governance">
      <div className="space-y-6 text-[#0F0F14]">
        {/* Intro Banner */}
        <div className="p-4 bg-[#F8F9FA] rounded-xl border border-[#E5E5E5]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs font-bold uppercase tracking-wider text-[#666]">Current Consent Status</span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-bold ${
                isGranted ? "bg-emerald-100 text-emerald-800" : "bg-zinc-100 text-zinc-800"
              }`}
            >
              {isGranted ? <Check size={12} /> : <X size={12} />}
              {isGranted ? "Analytics Active" : "Analytics Disabled"}
            </span>
          </div>
          <p className="text-xs text-[#555] leading-relaxed">
            Deployment Region: <strong className="uppercase">{consent.region}</strong> ({consent.region === "strict" ? "Strict Opt-In / GDPR Compliance Mode" : "Standard Privacy Mode"}).
          </p>
        </div>

        {/* Guarantees Grid */}
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-[#666] mb-3">Our Non-Surveillance Guarantees</h4>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="p-3 bg-white rounded-xl border border-[#E5E5E5] flex items-start gap-2.5">
              <EyeOff size={16} className="text-[#FF6B6B] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-[#0F0F14]">Zero Wallet Address Tracking</p>
                <p className="text-[11px] text-[#666]">Stellar public keys and accounts are never sent or stored in analytics sinks.</p>
              </div>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#E5E5E5] flex items-start gap-2.5">
              <Lock size={16} className="text-[#FF6B6B] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-[#0F0F14]">Zero Transaction XDR</p>
                <p className="text-[11px] text-[#666]">Raw transaction envelopes and signatures are strictly excluded from telemetry.</p>
              </div>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#E5E5E5] flex items-start gap-2.5">
              <Shield size={16} className="text-[#FF6B6B] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-[#0F0F14]">No Receipts or OCR Blobs</p>
                <p className="text-[11px] text-[#666]">Receipt images, itemized text, and attachments are kept strictly on your local device.</p>
              </div>
            </div>
            <div className="p-3 bg-white rounded-xl border border-[#E5E5E5] flex items-start gap-2.5">
              <Globe size={16} className="text-[#2DD4BF] shrink-0 mt-0.5" />
              <div>
                <p className="text-xs font-bold text-[#0F0F14]">Only Non-Sensitive Funnels</p>
                <p className="text-[11px] text-[#666]">Only aggregate counts (e.g. wallet support failures, currency distribution) are measured.</p>
              </div>
            </div>
          </div>
        </div>

        {/* What is collected */}
        <div>
          <h4 className="text-xs font-bold uppercase tracking-wider text-[#666] mb-2">Public Event Taxonomy ({Object.keys(EVENT_TAXONOMY).length} Events)</h4>
          <p className="text-xs text-[#555] mb-3">
            All telemetry follows an immutable, versioned schema (`v1.0.0`) reviewed and verified by security and legal gatekeepers.
          </p>
          <div className="max-h-48 overflow-y-auto space-y-1.5 p-2 bg-[#F8F9FA] rounded-xl border border-[#E5E5E5] text-xs">
            {Object.values(EVENT_TAXONOMY).map((evt) => (
              <div key={evt.name} className="p-2 bg-white rounded-lg border border-[#EEE] flex items-center justify-between">
                <div>
                  <span className="font-mono font-semibold text-[#0F0F14]">{evt.name}</span>
                  <p className="text-[11px] text-[#777]">{evt.description}</p>
                </div>
                <span className="text-[10px] uppercase font-bold text-[#888] bg-[#F0F0F0] px-2 py-0.5 rounded">
                  {evt.stage}
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Action Toggle */}
        <div className="pt-3 border-t border-[#E5E5E5] flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-[#0F0F14]">Enable Product Analytics</p>
            <p className="text-xs text-[#777]">You can change or revoke this decision at any time.</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                updateConsent(!isGranted);
              }}
              className={`px-4 py-2 rounded-xl text-xs font-bold transition-all ${
                isGranted
                  ? "bg-[#FF6B6B]/10 text-[#FF6B6B] hover:bg-[#FF6B6B]/20"
                  : "bg-[#2DD4BF] text-[#0F0F14] hover:bg-[#2DD4BF]/90"
              }`}
            >
              {isGranted ? "Revoke Consent" : "Grant Consent"}
            </button>
            <button
              onClick={closeConsentModal}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-[#F0F0F0] text-[#555] hover:bg-[#E5E5E5] transition-all"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
}
