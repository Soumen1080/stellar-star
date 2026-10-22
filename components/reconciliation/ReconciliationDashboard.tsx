"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  RefreshCw,
  AlertTriangle,
  AlertOctagon,
  CheckCircle2,
  Clock,
  ExternalLink,
  Search,
  Filter,
  ShieldAlert,
  ArrowRight,
  TrendingDown,
  Layers,
  Database,
  Activity,
  Play,
} from "lucide-react";
import { formatAddress } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";
import type {
  ReconciliationJob,
  ReconciliationReport,
  ReconciliationSummary,
  ReconciliationAlert,
  ReconciliationJobStatus,
} from "@/types/reconciliation";

export function ReconciliationDashboard() {
  const { success, error, info } = useToast();

  const [loading, setLoading] = useState(true);
  const [runningWorker, setRunningWorker] = useState(false);
  const [report, setReport] = useState<ReconciliationReport | null>(null);

  // Filters
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [walletFilter, setWalletFilter] = useState("");
  const [txHashFilter, setTxHashFilter] = useState("");
  const [tripIdFilter, setTripIdFilter] = useState("");
  const [selectedJobForDetail, setSelectedJobForDetail] = useState<ReconciliationJob | null>(null);

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      const params = new URLSearchParams();
      if (selectedStatus !== "all") params.set("status", selectedStatus);
      if (walletFilter.trim()) params.set("wallet", walletFilter.trim());
      if (txHashFilter.trim()) params.set("txHash", txHashFilter.trim());
      if (tripIdFilter.trim()) params.set("tripId", tripIdFilter.trim());

      const res = await fetch(`/api/settlement/reconciliation-worker?${params.toString()}`);
      const data = await res.json();
      if (res.ok && data.ok) {
        setReport(data as ReconciliationReport);
      } else {
        error("Failed to load report", data.error || "Unable to retrieve reconciliation metrics.");
      }
    } catch (err) {
      error("Network error", "Unable to contact reconciliation service.");
    } finally {
      setLoading(false);
    }
  }, [selectedStatus, walletFilter, txHashFilter, tripIdFilter, error]);

  useEffect(() => {
    void fetchReport();
  }, [fetchReport]);

  const handleRunWorker = async () => {
    try {
      setRunningWorker(true);
      const res = await fetch("/api/settlement/reconciliation-worker", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchSize: 20 }),
      });
      const data = await res.json();
      if (res.ok && data.ok) {
        const { processed, recorded, escalated, pending, failed } = data.result;
        success(
          "Worker execution completed",
          `Processed ${processed} jobs (${recorded} recorded, ${escalated} escalated, ${pending} pending, ${failed} failed).`,
        );
        void fetchReport();
      } else {
        error("Worker run failed", data.error || "Error executing reconciliation worker.");
      }
    } catch {
      error("Network error", "Failed to trigger reconciliation worker.");
    } finally {
      setRunningWorker(false);
    }
  };

  const getStatusBadge = (status: ReconciliationJobStatus) => {
    switch (status) {
      case "recorded":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
            <CheckCircle2 size={12} /> Recorded
          </span>
        );
      case "escalated":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 animate-pulse">
            <ShieldAlert size={12} /> Escalated (Ambiguous)
          </span>
        );
      case "not_submitted":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
            <Clock size={12} /> Not Submitted
          </span>
        );
      case "submitted_not_confirmed":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800">
            <Activity size={12} /> Polling Ledger
          </span>
        );
      case "confirmed_not_recorded":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-purple-100 text-purple-800">
            <Layers size={12} /> Repairing Sync
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 text-zinc-700">
            <AlertOctagon size={12} /> Failed
          </span>
        );
    }
  };

  const summary = report?.summary;
  const alerts = report?.alerts ?? [];

  return (
    <div className="space-y-6">
      {/* Header bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#E5E5E5]">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#0F0F14] flex items-center gap-2">
            <Activity className="text-[#2DD4BF]" size={28} />
            Automated On-Chain Reconciliation Worker
          </h1>
          <p className="text-sm text-[#555] mt-1">
            Server-side durable queue verifying pending payments, ledger finality, and anti-ambiguity escalations.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            onClick={() => void fetchReport()}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium text-[#555] hover:text-[#0F0F14] bg-white border border-[#E5E5E5] rounded-xl hover:bg-black/5 transition shadow-sm"
          >
            <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
          <button
            onClick={handleRunWorker}
            disabled={runningWorker}
            className="flex items-center gap-2 px-4 py-2 text-sm font-semibold text-[#0F0F14] bg-[#2DD4BF] hover:bg-[#26b8a5] rounded-xl transition shadow-sm disabled:opacity-60"
          >
            <Play size={15} className={runningWorker ? "animate-spin" : ""} />
            {runningWorker ? "Worker Running..." : "Run Worker Now"}
          </button>
        </div>
      </div>

      {/* Alert Banners */}
      {alerts.length > 0 && (
        <div className="space-y-2">
          {alerts.map((alert, idx) => (
            <div
              key={idx}
              className={`p-4 rounded-xl border flex items-start gap-3 ${
                alert.level === "critical"
                  ? "bg-red-50 border-red-200 text-red-900"
                  : "bg-amber-50 border-amber-200 text-amber-900"
              }`}
            >
              {alert.level === "critical" ? (
                <AlertOctagon className="text-red-600 shrink-0 mt-0.5" size={18} />
              ) : (
                <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={18} />
              )}
              <div className="flex-1 text-sm">
                <span className="font-bold mr-1">
                  [{alert.level.toUpperCase()} ALERT]
                </span>
                {alert.message}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
        <div className="p-4 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="text-xs font-semibold text-[#888] uppercase tracking-wider">Total Tracked</div>
          <div className="text-2xl font-bold text-[#0F0F14] mt-2">{summary?.total ?? 0}</div>
          <div className="text-xs text-[#666] mt-1">Durable queue rows</div>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="text-xs font-semibold text-amber-700 uppercase tracking-wider flex items-center justify-between">
            <span>Pending</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-amber-50 rounded">
              Limit: {report?.thresholds.maxPendingQueue ?? 10}
            </span>
          </div>
          <div className="text-2xl font-bold text-amber-800 mt-2">{summary?.totalPending ?? 0}</div>
          <div className="text-[11px] text-[#666] mt-1">
            Aging: &lt;5m: {summary?.pendingAging.under5m ?? 0} | 5-15m: {summary?.pendingAging.from5mTo15m ?? 0} | &gt;15m:{" "}
            <span className={summary?.pendingAging.over15m ? "text-red-600 font-bold" : ""}>
              {summary?.pendingAging.over15m ?? 0}
            </span>
          </div>
        </div>

        <div className={`p-4 bg-white rounded-2xl border shadow-sm ${summary?.escalated ? "border-red-300 ring-2 ring-red-100" : "border-[#E5E5E5]"}`}>
          <div className="text-xs font-semibold text-red-700 uppercase tracking-wider flex items-center justify-between">
            <span>Escalated</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-red-50 text-red-700 rounded">
              Needs Review
            </span>
          </div>
          <div className="text-2xl font-bold text-red-700 mt-2">{summary?.escalated ?? 0}</div>
          <div className="text-xs text-[#666] mt-1">Ambiguous; never auto-paid</div>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="text-xs font-semibold text-emerald-700 uppercase tracking-wider">Recorded</div>
          <div className="text-2xl font-bold text-emerald-800 mt-2">{summary?.recorded ?? 0}</div>
          <div className="text-xs text-[#666] mt-1">Proof confirmed on-chain</div>
        </div>

        <div className="p-4 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="text-xs font-semibold text-zinc-600 uppercase tracking-wider flex items-center justify-between">
            <span>Failed</span>
            <span className="text-[10px] font-mono px-1.5 py-0.5 bg-zinc-100 rounded">
              Rate: {summary?.failureRatePercent.toFixed(1) ?? "0.0"}%
            </span>
          </div>
          <div className="text-2xl font-bold text-zinc-800 mt-2">{summary?.failed ?? 0}</div>
          <div className="text-xs text-[#666] mt-1">Expired / invalid txs</div>
        </div>
      </div>

      {/* Filter and Query controls */}
      <div className="p-4 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          {["all", "pending", "escalated", "not_submitted", "submitted_not_confirmed", "confirmed_not_recorded", "recorded", "failed"].map((st) => (
            <button
              key={st}
              onClick={() => setSelectedStatus(st)}
              className={`px-3 py-1.5 text-xs font-semibold rounded-xl capitalize transition ${
                selectedStatus === st
                  ? "bg-[#0F0F14] text-white"
                  : "bg-[#F6F6F6] text-[#555] hover:text-[#0F0F14] hover:bg-[#EDEDED]"
              }`}
            >
              {st.replace(/_/g, " ")}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-2 border-t border-[#F0F0F0]">
          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-[#888]" />
            <input
              type="text"
              placeholder="Filter by wallet address..."
              value={walletFilter}
              onChange={(e) => setWalletFilter(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#2DD4BF]"
            />
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-[#888]" />
            <input
              type="text"
              placeholder="Filter by tx hash..."
              value={txHashFilter}
              onChange={(e) => setTxHashFilter(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#2DD4BF]"
            />
          </div>
          <div className="relative">
            <Search size={14} className="absolute left-3 top-3 text-[#888]" />
            <input
              type="text"
              placeholder="Filter by trip ID..."
              value={tripIdFilter}
              onChange={(e) => setTripIdFilter(e.target.value)}
              className="w-full pl-9 pr-3 py-2 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-1 focus:ring-[#2DD4BF]"
            />
          </div>
        </div>
      </div>

      {/* Jobs Table */}
      <div className="bg-white rounded-2xl border border-[#E5E5E5] shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-[#E5E5E5] flex items-center justify-between">
          <div className="text-sm font-bold text-[#0F0F14]">
            Reconciliation Queue ({report?.totalFiltered ?? 0} matching)
          </div>
          <div className="text-xs text-[#888]">
            Polled with rate limits and exponential backoff
          </div>
        </div>

        {report?.jobs.length === 0 ? (
          <div className="p-12 text-center text-sm text-[#888]">
            No reconciliation jobs match the current filters.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[#FAFAFA] border-b border-[#E5E5E5] text-[#777] font-semibold uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Debt / Wallets</th>
                  <th className="px-4 py-3">Amount</th>
                  <th className="px-4 py-3">Transaction</th>
                  <th className="px-4 py-3">Attempts & Next Run</th>
                  <th className="px-4 py-3 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F0F0]">
                {report?.jobs.map((job) => (
                  <tr key={job.id} className="hover:bg-black/[0.01] transition">
                    <td className="px-4 py-3 align-top">
                      {getStatusBadge(job.status)}
                      {job.escalationReason && (
                        <p className="text-[11px] text-red-600 mt-1 max-w-xs truncate" title={job.escalationReason}>
                          {job.escalationReason}
                        </p>
                      )}
                    </td>

                    <td className="px-4 py-3 align-top">
                      <div className="font-mono text-[#0F0F14]">
                        Debtor: {formatAddress(job.memberWallet, 6)}
                      </div>
                      <div className="font-mono text-[#666] flex items-center gap-1 mt-0.5">
                        <ArrowRight size={10} /> Creditor: {formatAddress(job.payerWallet, 6)}
                      </div>
                      <div className="text-[10px] text-[#888] mt-0.5">Trip: {job.tripId}</div>
                    </td>

                    <td className="px-4 py-3 align-top">
                      <div className="font-bold text-[#0F0F14]">
                        {job.amount} {job.asset}
                      </div>
                      <div className="text-[10px] font-mono text-[#888] mt-0.5">
                        {job.amountStroops} stroops
                      </div>
                    </td>

                    <td className="px-4 py-3 align-top">
                      {job.txHash ? (
                        <a
                          href={`https://stellar.expert/explorer/testnet/tx/${job.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[#2563EB] hover:underline flex items-center gap-1"
                        >
                          {formatAddress(job.txHash, 8)}
                          <ExternalLink size={10} />
                        </a>
                      ) : (
                        <span className="text-[#888] italic">Unsubmitted</span>
                      )}
                      {job.ledger && (
                        <div className="text-[10px] text-[#666] mt-0.5">Ledger: #{job.ledger}</div>
                      )}
                    </td>

                    <td className="px-4 py-3 align-top">
                      <div className="text-[#0F0F14]">
                        {job.attempts} / {job.maxAttempts} tries
                      </div>
                      <div className="text-[10px] text-[#888] mt-0.5">
                        Next: {new Date(job.nextAttemptAt).toLocaleTimeString()}
                      </div>
                    </td>

                    <td className="px-4 py-3 align-top text-right">
                      <button
                        onClick={() => setSelectedJobForDetail(job)}
                        className="px-2.5 py-1 text-xs font-medium text-[#0F0F14] bg-[#F6F6F6] hover:bg-[#EDEDED] rounded-lg transition"
                      >
                        Inspect
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Modal / Drawer for Inspection */}
      {selectedJobForDetail && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl border border-[#E5E5E5] shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-[#E5E5E5]">
              <h3 className="font-bold text-[#0F0F14] flex items-center gap-2">
                <Database size={18} className="text-[#2DD4BF]" />
                Job Inspection: {formatAddress(selectedJobForDetail.id, 6)}
              </h3>
              <button
                onClick={() => setSelectedJobForDetail(null)}
                className="text-[#888] hover:text-[#0F0F14] text-lg leading-none"
              >
                &times;
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div className="flex justify-between">
                <span className="text-[#777]">Status:</span>
                <div>{getStatusBadge(selectedJobForDetail.status)}</div>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Job ID:</span>
                <span>{selectedJobForDetail.id}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Trip ID:</span>
                <span>{selectedJobForDetail.tripId}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Expense ID:</span>
                <span>{selectedJobForDetail.expenseId}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Payer (Creditor):</span>
                <span>{formatAddress(selectedJobForDetail.payerWallet, 10)}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Member (Debtor):</span>
                <span>{formatAddress(selectedJobForDetail.memberWallet, 10)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#777]">Amount / Asset:</span>
                <span className="font-bold">
                  {selectedJobForDetail.amount} {selectedJobForDetail.asset} ({selectedJobForDetail.amountStroops} stroops)
                </span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-[#777]">Tx Hash:</span>
                {selectedJobForDetail.txHash ? (
                  <a
                    href={`https://stellar.expert/explorer/testnet/tx/${selectedJobForDetail.txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[#2563EB] hover:underline flex items-center gap-1"
                  >
                    {formatAddress(selectedJobForDetail.txHash, 8)}
                    <ExternalLink size={10} />
                  </a>
                ) : (
                  <span>None</span>
                )}
              </div>

              {selectedJobForDetail.escalationReason && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-xl text-red-900 mt-2">
                  <div className="font-bold flex items-center gap-1 mb-1">
                    <ShieldAlert size={14} /> Escalation Reason (Anti-Ambiguity Guard)
                  </div>
                  <p className="text-[11px] leading-relaxed">
                    {selectedJobForDetail.escalationReason}
                  </p>
                  <p className="text-[10px] text-red-700 mt-1 italic">
                    Per Invariant 4, this payment is never automatically marked paid. Dual-control or manual review is required.
                  </p>
                </div>
              )}

              {selectedJobForDetail.errorMessage && (
                <div className="p-3 bg-zinc-50 border border-zinc-200 rounded-xl text-zinc-800 mt-2">
                  <span className="font-semibold">Terminal Error: </span>
                  {selectedJobForDetail.errorMessage}
                </div>
              )}
            </div>

            <div className="pt-3 border-t border-[#E5E5E5] flex justify-end">
              <button
                onClick={() => setSelectedJobForDetail(null)}
                className="px-4 py-2 text-xs font-semibold text-[#0F0F14] bg-[#F6F6F6] hover:bg-[#EDEDED] rounded-xl transition"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
