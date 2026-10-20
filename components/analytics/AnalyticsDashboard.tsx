"use client";

import React, { useState } from "react";
import {
  TrendingUp,
  CheckCircle2,
  AlertTriangle,
  ShieldCheck,
  Activity,
  Layers,
  Lock,
  RefreshCw,
  Sliders,
} from "lucide-react";
import { useAnalytics } from "@/context/AnalyticsContext";
import { EVENT_TAXONOMY } from "@/lib/analytics/taxonomy";
import { ANALYTICS_SCHEMA_VERSION } from "@/lib/analytics/types";

export function AnalyticsDashboard() {
  const { metrics, consent, openConsentModal, refreshMetrics } = useAnalytics();
  const [activeTab, setActiveTab] = useState<"metrics" | "taxonomy">("metrics");

  return (
    <div className="space-y-6">
      {/* Header and Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-6 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <h2 className="text-xl font-black text-[#0F0F14]">Product Analytics & Funnels</h2>
            <span className="px-2 py-0.5 text-[11px] font-bold bg-[#2DD4BF]/20 text-[#134E4A] rounded-full">
              Schema v{ANALYTICS_SCHEMA_VERSION}
            </span>
          </div>
          <p className="text-sm text-[#666]">
            Transparent, aggregate activation and friction telemetry with explicit user consent.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={refreshMetrics}
            className="flex items-center gap-1.5 px-3 py-2 bg-[#F6F6F6] hover:bg-[#EDEDED] text-[#0F0F14] text-xs font-bold rounded-xl transition-all"
            title="Refresh metrics"
          >
            <RefreshCw size={14} />
            Refresh
          </button>
          <button
            onClick={openConsentModal}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-[#0F0F14] hover:bg-[#252530] text-white text-xs font-bold rounded-xl transition-all"
          >
            <Sliders size={14} className="text-[#2DD4BF]" />
            Consent Preferences
          </button>
        </div>
      </div>

      {/* Redaction Guarantee Badge */}
      <div className="flex items-center justify-between p-4 bg-emerald-50 border border-emerald-200 rounded-2xl">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-xl bg-emerald-100 flex items-center justify-center shrink-0">
            <ShieldCheck size={18} className="text-emerald-700" />
          </div>
          <div>
            <h4 className="text-xs font-bold text-emerald-950 uppercase tracking-wider">
              Privacy & Redaction Verified
            </h4>
            <p className="text-xs text-emerald-800">
              Zero wallet addresses, zero transaction XDR, and zero receipt descriptions present in ingested telemetry.
            </p>
          </div>
        </div>
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-bold text-emerald-800 bg-emerald-100/60 px-3 py-1 rounded-full">
          <Lock size={12} />
          {consent.status === "granted" ? "Consented Telemetry" : "Consent Pending / Opted-Out"}
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 border-b border-[#E5E5E5] pb-2">
        <button
          onClick={() => setActiveTab("metrics")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeTab === "metrics"
              ? "bg-[#0F0F14] text-white shadow-sm"
              : "text-[#666] hover:text-[#0F0F14] hover:bg-black/5"
          }`}
        >
          <Activity size={14} />
          Funnel & Failure Rates
        </button>
        <button
          onClick={() => setActiveTab("taxonomy")}
          className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-bold transition-all ${
            activeTab === "taxonomy"
              ? "bg-[#0F0F14] text-white shadow-sm"
              : "text-[#666] hover:text-[#0F0F14] hover:bg-black/5"
          }`}
        >
          <Layers size={14} />
          Public Event Taxonomy
        </button>
      </div>

      {activeTab === "metrics" ? (
        <>
          {/* Key Metric KPI Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <div className="flex items-center justify-between text-[#888] mb-2">
                <span className="text-xs font-bold uppercase tracking-wider">Activation Rate</span>
                <TrendingUp size={16} className="text-[#2DD4BF]" />
              </div>
              <div className="text-3xl font-black text-[#0F0F14] mb-1">
                {metrics.activationRate}%
              </div>
              <p className="text-xs text-[#666]">
                {metrics.walletConnections} connected of {Math.max(metrics.totalVisitors, 1)} visitors
              </p>
            </div>

            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <div className="flex items-center justify-between text-[#888] mb-2">
                <span className="text-xs font-bold uppercase tracking-wider">Payment Completion</span>
                <CheckCircle2 size={16} className="text-emerald-500" />
              </div>
              <div className="text-3xl font-black text-[#0F0F14] mb-1">
                {metrics.paymentCompletionRate}%
              </div>
              <p className="text-xs text-[#666]">
                {metrics.paymentsCompleted} completed of {metrics.paymentsCompleted + metrics.paymentsFailed} attempts
              </p>
            </div>

            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <div className="flex items-center justify-between text-[#888] mb-2">
                <span className="text-xs font-bold uppercase tracking-wider">Expense Creation</span>
                <CheckCircle2 size={16} className="text-blue-500" />
              </div>
              <div className="text-3xl font-black text-[#0F0F14] mb-1">
                {metrics.expenseCompletionRate}%
              </div>
              <p className="text-xs text-[#666]">
                {metrics.expensesCreated} total expenses split & saved
              </p>
            </div>

            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <div className="flex items-center justify-between text-[#888] mb-2">
                <span className="text-xs font-bold uppercase tracking-wider">Friction / Failure Rate</span>
                <AlertTriangle size={16} className="text-[#FF6B6B]" />
              </div>
              <div className="text-3xl font-black text-[#0F0F14] mb-1">
                {metrics.failureRate}%
              </div>
              <p className="text-xs text-[#666]">
                {metrics.paymentsFailed} failed payment attempts
              </p>
            </div>
          </div>

          {/* Funnel Progress Table */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <h3 className="text-sm font-bold text-[#0F0F14] mb-3">Core Activation Funnel</h3>
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#666]">1. App Visit</span>
                  <span className="font-bold text-[#0F0F14]">{metrics.totalVisitors}</span>
                </div>
                <div className="w-full bg-[#F0F0F0] h-2 rounded-full overflow-hidden">
                  <div className="bg-[#0F0F14] h-full" style={{ width: "100%" }} />
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#666]">2. Wallet Connected</span>
                  <span className="font-bold text-[#0F0F14]">
                    {metrics.walletConnections} ({metrics.activationRate}%)
                  </span>
                </div>
                <div className="w-full bg-[#F0F0F0] h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-[#2DD4BF] h-full"
                    style={{ width: `${Math.min(metrics.activationRate, 100)}%` }}
                  />
                </div>

                <div className="flex items-center justify-between text-xs">
                  <span className="text-[#666]">3. Trip Created</span>
                  <span className="font-bold text-[#0F0F14]">{metrics.tripsCreated}</span>
                </div>
                <div className="w-full bg-[#F0F0F0] h-2 rounded-full overflow-hidden">
                  <div
                    className="bg-[#134E4A] h-full"
                    style={{
                      width: `${Math.min((metrics.tripsCreated / Math.max(metrics.totalVisitors, 1)) * 100, 100)}%`,
                    }}
                  />
                </div>
              </div>
            </div>

            {/* Friction & Failure Breakdown */}
            <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
              <h3 className="text-sm font-bold text-[#0F0F14] mb-3">Friction & Failures by Reason</h3>
              {Object.keys(metrics.failuresByCode).length === 0 ? (
                <div className="py-8 text-center text-xs text-[#888]">
                  No friction or failures recorded in the current telemetry sample.
                </div>
              ) : (
                <div className="space-y-2">
                  {Object.entries(metrics.failuresByCode).map(([code, count]) => (
                    <div
                      key={code}
                      className="flex items-center justify-between p-2.5 bg-[#F8F9FA] rounded-xl text-xs"
                    >
                      <span className="font-mono text-[#0F0F14] font-semibold">{code}</span>
                      <span className="px-2 py-0.5 bg-[#FF6B6B]/10 text-[#FF6B6B] font-bold rounded">
                        {count} occurrences
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      ) : (
        /* Event Taxonomy Table */
        <div className="bg-white rounded-2xl border border-[#E5E5E5] overflow-hidden shadow-sm">
          <div className="p-5 border-b border-[#E5E5E5]">
            <h3 className="text-sm font-bold text-[#0F0F14]">Public Non-Sensitive Event Taxonomy</h3>
            <p className="text-xs text-[#666]">
              All events are strictly scoped to user interaction boundaries and verified to prevent sensitive data leaks.
            </p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#F8F9FA] text-[#666] font-bold uppercase tracking-wider border-b border-[#E5E5E5]">
                <tr>
                  <th className="px-4 py-3">Event Name</th>
                  <th className="px-4 py-3">Funnel Stage</th>
                  <th className="px-4 py-3">Allowed Properties</th>
                  <th className="px-4 py-3">Strictly Excluded</th>
                  <th className="px-4 py-3">Collection Rationale</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#E5E5E5]">
                {Object.values(EVENT_TAXONOMY).map((evt) => (
                  <tr key={evt.name} className="hover:bg-[#FBFBFB]">
                    <td className="px-4 py-3 font-mono font-bold text-[#0F0F14]">{evt.name}</td>
                    <td className="px-4 py-3">
                      <span className="px-2 py-0.5 bg-black/5 text-[#0F0F14] font-bold rounded capitalize">
                        {evt.stage}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono text-[#555]">
                      {evt.allowedProperties.length > 0 ? evt.allowedProperties.join(", ") : "—"}
                    </td>
                    <td className="px-4 py-3 font-mono text-[#FF6B6B]">
                      {evt.strictlyForbidden.join(", ")}
                    </td>
                    <td className="px-4 py-3 text-[#555] max-w-xs">{evt.rationale}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
