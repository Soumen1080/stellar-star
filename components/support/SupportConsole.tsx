"use client";

import React, { useState } from "react";
import {
  Search,
  Shield,
  ShieldAlert,
  ExternalLink,
  CheckCircle2,
  Clock,
  AlertTriangle,
  XCircle,
  Copy,
  Check,
  RefreshCw,
  FileText,
  Lock,
  ArrowRight,
  Eye,
  UserCheck,
  HelpCircle,
} from "lucide-react";
import {
  type SupportIncidentView,
  type SupportQueryType,
  type TimelineEvent,
  type SupportAuditLogEntry,
  type CorrectiveActionProposal,
} from "@/lib/support/types";
import { formatAddress, copyToClipboard } from "@/lib/utils";

const QUERY_TYPE_LABELS: Record<SupportQueryType, string> = {
  tx_hash: "Transaction Hash",
  wallet: "Wallet Address",
  trip_id: "Trip ID",
  expense_id: "Expense ID",
  correlation_id: "Correlation ID",
};

export function SupportConsole() {
  const [query, setQuery] = useState("");
  const [queryType, setQueryType] = useState<string>("auto");
  const [staffSecret, setStaffSecret] = useState("");
  const [loading, setLoading] = useState(false);
  const [incident, setIncident] = useState<SupportIncidentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // Audit logs state
  const [showAuditLogs, setShowAuditLogs] = useState(false);
  const [auditLogs, setAuditLogs] = useState<SupportAuditLogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  // Dual-control corrective actions state
  const [showDualControlModal, setShowDualControlModal] = useState(false);
  const [actionType, setActionType] = useState<"FORCE_RECONCILE" | "MARK_INTENT_FAILED" | "FLAG_AMBIGUOUS_INVESTIGATION">("FORCE_RECONCILE");
  const [ticketRef, setTicketRef] = useState("");
  const [reason, setReason] = useState("");
  const [proposing, setProposing] = useState(false);
  const [proposals, setProposals] = useState<CorrectiveActionProposal[]>([]);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const handleCopy = async (text: string, key: string) => {
    const ok = await copyToClipboard(text);
    if (ok) {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2000);
    }
  };

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim()) return;

    setLoading(true);
    setError(null);
    setIncident(null);
    setActionSuccess(null);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (staffSecret.trim()) {
        headers["x-staff-secret"] = staffSecret.trim();
      }

      const res = await fetch("/api/support/lookup", {
        method: "POST",
        headers,
        body: JSON.stringify({
          query: query.trim(),
          queryType: queryType === "auto" ? undefined : queryType,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || `Lookup failed with HTTP ${res.status}`);
      }

      setIncident(json.data);
      loadProposals();
    } catch (err: any) {
      setError(err?.message || "Failed to fetch incident details.");
    } finally {
      setLoading(false);
    }
  };

  const loadAuditLogs = async () => {
    setLoadingLogs(true);
    try {
      const headers: Record<string, string> = {};
      if (staffSecret.trim()) headers["x-staff-secret"] = staffSecret.trim();

      const res = await fetch("/api/support/audit-logs?limit=30", { headers });
      const json = await res.json();
      if (res.ok && json.data) {
        setAuditLogs(json.data);
      }
    } catch {}
    setLoadingLogs(false);
  };

  const loadProposals = async () => {
    try {
      const headers: Record<string, string> = {};
      if (staffSecret.trim()) headers["x-staff-secret"] = staffSecret.trim();

      const res = await fetch("/api/support/actions?limit=10", { headers });
      const json = await res.json();
      if (res.ok && json.data) {
        setProposals(json.data);
      }
    } catch {}
  };

  const handleProposeAction = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!incident?.activeIntent && !incident?.expense) return;

    setProposing(true);
    setActionError(null);
    setActionSuccess(null);

    try {
      const targetId = incident.activeIntent?.id || incident.expense?.id || query;
      const targetType = incident.activeIntent ? "intent" : "expense";

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (staffSecret.trim()) headers["x-staff-secret"] = staffSecret.trim();

      const res = await fetch("/api/support/actions/propose", {
        method: "POST",
        headers,
        body: JSON.stringify({
          actionType,
          targetId,
          targetType,
          ticketRef,
          reason,
        }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to submit proposal.");
      }

      setActionSuccess(`Proposal submitted (ID: ${json.data.id.slice(0, 8)}...). Pending approval by a second staff member.`);
      setShowDualControlModal(false);
      setTicketRef("");
      setReason("");
      loadProposals();
    } catch (err: any) {
      setActionError(err?.message || "Failed to propose corrective action.");
    } finally {
      setProposing(false);
    }
  };

  const handleApproveProposal = async (proposalId: string) => {
    setActionError(null);
    setActionSuccess(null);

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (staffSecret.trim()) headers["x-staff-secret"] = staffSecret.trim();

      const res = await fetch("/api/support/actions/approve", {
        method: "POST",
        headers,
        body: JSON.stringify({ proposalId }),
      });

      const json = await res.json();
      if (!res.ok) {
        throw new Error(json.error || "Failed to approve corrective action.");
      }

      setActionSuccess(`Action ${json.data.actionType} successfully executed and audit logged.`);
      loadProposals();
      handleSearch();
    } catch (err: any) {
      setActionError(err?.message || "Failed to approve corrective action.");
    }
  };

  return (
    <div className="space-y-8">
      {/* ── Console Header ── */}
      <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 sm:p-8 shadow-sm">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#F0F0F0] pb-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="p-2 bg-emerald-50 text-emerald-700 rounded-xl">
                <Shield className="w-5 h-5" />
              </span>
              <h1 className="text-xl sm:text-2xl font-bold text-[#0F0F14]">
                Incident-Response & Support Console
              </h1>
            </div>
            <p className="text-sm text-[#666] mt-1">
              Read-only payment lifecycle diagnostics, cryptographic verification, and audited dual-control resolution.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-[#F6F6F6] text-[#444] rounded-full text-xs font-semibold uppercase tracking-wider">
              <Lock className="w-3.5 h-3.5 text-emerald-600" />
              Read-Only Default
            </span>
            <button
              onClick={() => {
                setShowAuditLogs(!showAuditLogs);
                if (!showAuditLogs) loadAuditLogs();
              }}
              className="px-3 py-1.5 text-xs font-medium bg-[#F6F6F6] hover:bg-[#EDEDED] text-[#0F0F14] rounded-xl transition-colors flex items-center gap-1.5"
            >
              <FileText className="w-3.5 h-3.5 text-[#666]" />
              {showAuditLogs ? "Hide Audit Log" : "View Audit Log"}
            </button>
          </div>
        </div>

        {/* ── Search Form ── */}
        <form onSubmit={handleSearch} className="mt-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
            <div className="md:col-span-3">
              <label className="block text-xs font-semibold text-[#555] uppercase tracking-wider mb-1.5">
                Search By
              </label>
              <select
                value={queryType}
                onChange={(e) => setQueryType(e.target.value)}
                className="w-full h-11 px-3 text-sm bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] text-[#0F0F14]"
              >
                <option value="auto">Auto-Detect Type</option>
                <option value="tx_hash">Transaction Hash (64 hex)</option>
                <option value="wallet">Wallet Address (G...)</option>
                <option value="correlation_id">Correlation ID (req-...)</option>
                <option value="expense_id">Expense ID</option>
                <option value="trip_id">Trip ID</option>
              </select>
            </div>

            <div className="md:col-span-6">
              <label className="block text-xs font-semibold text-[#555] uppercase tracking-wider mb-1.5">
                Query Value
              </label>
              <div className="relative">
                <input
                  type="text"
                  placeholder="Paste transaction hash, wallet G..., expense ID, or correlation ID"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  className="w-full h-11 pl-10 pr-4 text-sm font-mono bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] text-[#0F0F14]"
                />
                <Search className="w-4 h-4 text-[#888] absolute left-3.5 top-3.5" />
              </div>
            </div>

            <div className="md:col-span-3 flex items-end">
              <button
                type="submit"
                disabled={loading || !query.trim()}
                className="w-full h-11 bg-[#0F0F14] hover:bg-[#222] text-white text-sm font-medium rounded-xl transition-all disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Lookup Incident
              </button>
            </div>
          </div>

          {/* Optional Staff Secret Field */}
          <div className="flex items-center gap-2 pt-2 text-xs text-[#666]">
            <span>Staff Secret / Operator Key (optional in dev):</span>
            <input
              type="password"
              placeholder="Enter SUPPORT_STAFF_SECRET if configured"
              value={staffSecret}
              onChange={(e) => setStaffSecret(e.target.value)}
              className="h-8 px-2.5 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-lg focus:outline-none focus:ring-1 focus:ring-[#2DD4BF] w-64"
            />
          </div>
        </form>
      </div>

      {/* ── Error Banner ── */}
      {error && (
        <div className="p-4 bg-rose-50 border border-rose-200 rounded-2xl flex items-start gap-3 text-rose-800 text-sm">
          <AlertTriangle className="w-5 h-5 text-rose-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Lookup Error</p>
            <p className="mt-0.5 text-rose-700">{error}</p>
          </div>
        </div>
      )}

      {/* ── Action Feedback Banners ── */}
      {actionSuccess && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-2xl flex items-start gap-3 text-emerald-800 text-sm">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Dual-Control Workflow Notice</p>
            <p className="mt-0.5 text-emerald-700">{actionSuccess}</p>
          </div>
        </div>
      )}

      {actionError && (
        <div className="p-4 bg-amber-50 border border-amber-200 rounded-2xl flex items-start gap-3 text-amber-800 text-sm">
          <ShieldAlert className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">Dual-Control Policy Rejection</p>
            <p className="mt-0.5 text-amber-700">{actionError}</p>
          </div>
        </div>
      )}

      {/* ── Audit Logs Drawer ── */}
      {showAuditLogs && (
        <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-base font-bold text-[#0F0F14] flex items-center gap-2">
              <FileText className="w-4 h-4 text-[#666]" />
              Staff Lookup Audit Trail (Immutable Log)
            </h3>
            <button
              onClick={loadAuditLogs}
              disabled={loadingLogs}
              className="text-xs text-[#666] hover:text-[#0F0F14] flex items-center gap-1"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingLogs ? "animate-spin" : ""}`} />
              Refresh
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[#E5E5E5] text-[#888]">
                  <th className="py-2 px-3 font-semibold">Timestamp</th>
                  <th className="py-2 px-3 font-semibold">Staff Identity</th>
                  <th className="py-2 px-3 font-semibold">Query Type</th>
                  <th className="py-2 px-3 font-semibold">Masked Query</th>
                  <th className="py-2 px-3 font-semibold">Results</th>
                  <th className="py-2 px-3 font-semibold">IP Address</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F0F0] text-[#333]">
                {auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="py-4 text-center text-[#888]">
                      No staff lookups recorded yet.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => (
                    <tr key={log.id} className="hover:bg-[#F9F9F9]">
                      <td className="py-2.5 px-3 font-mono">{new Date(log.timestamp).toLocaleTimeString()}</td>
                      <td className="py-2.5 px-3 font-medium text-[#0F0F14]">{log.staffIdentifier}</td>
                      <td className="py-2.5 px-3">
                        <span className="px-2 py-0.5 bg-[#EDEDED] text-[#444] rounded text-[11px] font-mono">
                          {log.queryType}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 font-mono text-[#555]">{log.queryValueMasked}</td>
                      <td className="py-2.5 px-3">{log.resultsCount > 0 ? "Found" : "None"}</td>
                      <td className="py-2.5 px-3 font-mono text-[#888]">{log.ipAddress}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* ── Incident Details View ── */}
      {incident && (
        <div className="space-y-6">
          {/* Header Bar */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <span
                  className={`px-3 py-1 rounded-full text-xs font-semibold uppercase tracking-wider ${
                    incident.found
                      ? incident.activeIntent?.status === "recorded"
                        ? "bg-emerald-50 text-emerald-700"
                        : incident.activeIntent?.status === "failed"
                        ? "bg-rose-50 text-rose-700"
                        : "bg-amber-50 text-amber-700"
                      : "bg-gray-100 text-gray-700"
                  }`}
                >
                  {incident.found ? incident.activeIntent?.status || "Found" : "No Matching Records"}
                </span>

                <span className="text-xs font-mono text-[#666]">
                  Type: {QUERY_TYPE_LABELS[incident.detectedType] || incident.detectedType}
                </span>
              </div>

              {incident.correlationId && (
                <div className="mt-2 flex items-center gap-2 text-xs text-[#555]">
                  <span>Correlation ID:</span>
                  <code className="font-mono bg-[#F6F6F6] px-2 py-0.5 rounded text-[#0F0F14]">
                    {incident.correlationId}
                  </code>
                  <button
                    onClick={() => handleCopy(incident.correlationId!, "corrId")}
                    className="text-[#888] hover:text-[#0F0F14]"
                    title="Copy Correlation ID"
                  >
                    {copiedKey === "corrId" ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  </button>
                </div>
              )}
            </div>

            {/* Quick Actions & Explorer Link */}
            <div className="flex items-center gap-3 flex-wrap">
              {incident.explorerLinks.txUrl && (
                <a
                  href={incident.explorerLinks.txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="px-3.5 py-2 bg-[#F6F6F6] hover:bg-[#EDEDED] text-[#0F0F14] text-xs font-medium rounded-xl transition-colors inline-flex items-center gap-1.5"
                >
                  View on Stellar Expert ({incident.explorerLinks.networkName})
                  <ExternalLink className="w-3.5 h-3.5 text-[#666]" />
                </a>
              )}

              <button
                onClick={() => setShowDualControlModal(true)}
                className="px-3.5 py-2 bg-[#0F0F14] hover:bg-[#222] text-white text-xs font-medium rounded-xl transition-colors inline-flex items-center gap-1.5"
              >
                <UserCheck className="w-3.5 h-3.5" />
                Dual-Control Action
              </button>
            </div>
          </div>

          {/* Privacy & Redaction Shield Banner */}
          <div className="p-4 bg-sky-50/70 border border-sky-100 rounded-2xl flex items-start gap-3 text-sky-900 text-xs">
            <Shield className="w-4 h-4 text-sky-600 shrink-0 mt-0.5" />
            <div>
              <span className="font-semibold">Privacy & Safety Guardrails Active: </span>
              All secret keys, signing seeds, authentication tokens, and user credentials have been strictly redacted.
              Support agents cannot edit financial state unilaterally.
            </div>
          </div>

          {/* 4 Diagnostic Information Cards Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: Expense */}
            <div className="bg-white border border-[#E5E5E5] rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between text-xs text-[#888] font-semibold uppercase tracking-wider">
                <span>Expense Item</span>
                <FileText className="w-4 h-4 text-[#888]" />
              </div>
              <div>
                <p className="text-base font-bold text-[#0F0F14] truncate">
                  {incident.expense?.title || "Expense Record N/A"}
                </p>
                <p className="text-sm font-semibold text-emerald-700 mt-0.5">
                  {incident.expense ? `${(incident.expense as any).totalAmount || (incident.expense as any).amount} ${(incident.expense as any).currency || "XLM"}` : "—"}
                </p>
              </div>
              <div className="pt-2 border-t border-[#F0F0F0] text-xs space-y-1 text-[#666]">
                <p>Trip: {incident.trip?.title || (incident.expense as any)?.tripId?.slice(0, 8) || (incident.expense as any)?.trip_id?.slice(0, 8) || "—"}</p>
                <p>Created: {(incident.expense as any)?.createdAt ? new Date((incident.expense as any).createdAt).toLocaleDateString() : (incident.expense as any)?.created_at ? new Date((incident.expense as any).created_at).toLocaleDateString() : "—"}</p>
              </div>
            </div>

            {/* Card 2: Settlement Intent */}
            <div className="bg-white border border-[#E5E5E5] rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between text-xs text-[#888] font-semibold uppercase tracking-wider">
                <span>Settlement Intent</span>
                <Clock className="w-4 h-4 text-[#888]" />
              </div>
              <div>
                <p className="text-base font-bold text-[#0F0F14] capitalize">
                  {incident.activeIntent?.status || "Intent N/A"}
                </p>
                <p className="text-xs font-mono text-[#666] truncate mt-0.5">
                  Key: {incident.activeIntent?.idempotencyKey || "—"}
                </p>
              </div>
              <div className="pt-2 border-t border-[#F0F0F0] text-xs space-y-1 text-[#666]">
                <p>Debtor: {incident.activeIntent ? formatAddress(incident.activeIntent.memberWallet, 4) : "—"}</p>
                <p>Creditor: {incident.activeIntent ? formatAddress(incident.activeIntent.payerWallet, 4) : "—"}</p>
              </div>
            </div>

            {/* Card 3: Stellar Horizon */}
            <div className="bg-white border border-[#E5E5E5] rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between text-xs text-[#888] font-semibold uppercase tracking-wider">
                <span>Stellar Ledger (Horizon)</span>
                <CheckCircle2 className="w-4 h-4 text-[#888]" />
              </div>
              <div>
                <p className="text-base font-bold text-[#0F0F14]">
                  {incident.horizonVerification?.verified
                    ? `Ledger #${incident.horizonVerification.ledger}`
                    : incident.horizonVerification?.error ? "Unconfirmed" : "Not Verified"}
                </p>
                <p className="text-xs text-[#666] truncate mt-0.5">
                  {incident.horizonVerification?.amountXlm ? `${incident.horizonVerification.amountXlm} XLM delivered` : "—"}
                </p>
              </div>
              <div className="pt-2 border-t border-[#F0F0F0] text-xs space-y-1 text-[#666]">
                <p>Path Payment: {incident.horizonVerification?.viaPath ? "Yes (DEX)" : "Direct"}</p>
                <p>Memo: {incident.horizonVerification?.memo || "None"}</p>
              </div>
            </div>

            {/* Card 4: Soroban Contract */}
            <div className="bg-white border border-[#E5E5E5] rounded-2xl p-5 shadow-sm space-y-3">
              <div className="flex items-center justify-between text-xs text-[#888] font-semibold uppercase tracking-wider">
                <span>Smart Contract Event</span>
                <Shield className="w-4 h-4 text-[#888]" />
              </div>
              <div>
                <p className="text-base font-bold text-[#0F0F14]">
                  {incident.contractEvent?.recordedOnChain ? "Anchored On-Chain" : "Contract Pending"}
                </p>
                <p className="text-xs font-mono text-[#666] truncate mt-0.5">
                  {incident.contractEvent?.contractId ? `${incident.contractEvent.contractId.slice(0, 10)}...` : "No Contract Configured"}
                </p>
              </div>
              <div className="pt-2 border-t border-[#F0F0F0] text-xs space-y-1 text-[#666]">
                <p>Event: {incident.contractEvent?.eventTopic || "N/A"}</p>
                <p>Status: {incident.contractEvent?.recordedOnChain ? "Verified Immutable" : "Off-chain Only"}</p>
              </div>
            </div>
          </div>

          {/* Chronological Incident Timeline */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 sm:p-8 shadow-sm space-y-6">
            <div>
              <h2 className="text-lg font-bold text-[#0F0F14] flex items-center gap-2">
                <Clock className="w-5 h-5 text-[#444]" />
                Cryptographic Payment Lifecycle Timeline
              </h2>
              <p className="text-xs text-[#666] mt-1">
                Sequential progression of payment intent, broadcast, consensus, and off-chain sync.
              </p>
            </div>

            <div className="relative pl-6 border-l-2 border-[#E5E5E5] space-y-8">
              {incident.timeline.length === 0 ? (
                <p className="text-sm text-[#888]">No timeline milestones recorded for this query.</p>
              ) : (
                incident.timeline.map((event, idx) => (
                  <div key={event.id || idx} className="relative group">
                    {/* Status node dot */}
                    <div
                      className={`absolute -left-[31px] top-1 w-4 h-4 rounded-full border-2 border-white shadow-sm ${
                        event.status === "success"
                          ? "bg-emerald-500"
                          : event.status === "failed"
                          ? "bg-rose-500"
                          : event.status === "warning"
                          ? "bg-amber-500"
                          : "bg-blue-500"
                      }`}
                    />

                    <div className="space-y-1">
                      <div className="flex items-center gap-3">
                        <span className="text-sm font-bold text-[#0F0F14]">{event.title}</span>
                        <span className="text-xs text-[#888] font-mono">
                          {event.timestamp ? new Date(event.timestamp).toLocaleTimeString() : ""}
                        </span>
                      </div>
                      <p className="text-xs text-[#555] leading-relaxed">{event.description}</p>

                      {event.explorerUrl && (
                        <a
                          href={event.explorerUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-teal-700 hover:text-teal-900 font-medium mt-1"
                        >
                          View proof on Stellar Expert
                          <ExternalLink className="w-3 h-3" />
                        </a>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Network Explorer Links Bar */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm space-y-3">
            <h3 className="text-sm font-bold text-[#0F0F14] flex items-center gap-2">
              <ExternalLink className="w-4 h-4 text-[#666]" />
              Verified Network Explorer Links ({incident.explorerLinks.networkName})
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
              {incident.explorerLinks.txUrl ? (
                <a
                  href={incident.explorerLinks.txUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-3 bg-[#F9F9F9] hover:bg-[#F2F2F2] rounded-xl flex items-center justify-between text-[#0F0F14]"
                >
                  <span className="truncate">Transaction Details</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#888]" />
                </a>
              ) : null}

              {incident.explorerLinks.memberWalletUrl ? (
                <a
                  href={incident.explorerLinks.memberWalletUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-3 bg-[#F9F9F9] hover:bg-[#F2F2F2] rounded-xl flex items-center justify-between text-[#0F0F14]"
                >
                  <span className="truncate">Payer Wallet Ledger</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#888]" />
                </a>
              ) : null}

              {incident.explorerLinks.payerWalletUrl ? (
                <a
                  href={incident.explorerLinks.payerWalletUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="p-3 bg-[#F9F9F9] hover:bg-[#F2F2F2] rounded-xl flex items-center justify-between text-[#0F0F14]"
                >
                  <span className="truncate">Payee Wallet Ledger</span>
                  <ExternalLink className="w-3.5 h-3.5 text-[#888]" />
                </a>
              ) : null}
            </div>
          </div>

          {/* Dual-Control Exceptional Actions Queue */}
          <div className="bg-white border border-[#E5E5E5] rounded-2xl p-6 shadow-sm space-y-4">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-[#0F0F14] flex items-center gap-2">
                  <UserCheck className="w-5 h-5 text-emerald-600" />
                  Dual-Control Governance (Four-Eyes Enforcement)
                </h3>
                <p className="text-xs text-[#666] mt-0.5">
                  Exceptional state repairs require two distinct staff members: one to propose and one to approve.
                </p>
              </div>

              <button
                onClick={() => setShowDualControlModal(true)}
                className="px-3 py-1.5 text-xs font-medium bg-[#0F0F14] hover:bg-[#222] text-white rounded-xl transition-all"
              >
                + Propose Action
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-[#E5E5E5] text-[#888]">
                    <th className="py-2 px-3 font-semibold">Action</th>
                    <th className="py-2 px-3 font-semibold">Ticket Ref</th>
                    <th className="py-2 px-3 font-semibold">Proposed By</th>
                    <th className="py-2 px-3 font-semibold">Reason</th>
                    <th className="py-2 px-3 font-semibold">Status</th>
                    <th className="py-2 px-3 font-semibold text-right">Approval Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#F0F0F0] text-[#333]">
                  {proposals.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-4 text-center text-[#888]">
                        No active corrective proposals.
                      </td>
                    </tr>
                  ) : (
                    proposals.map((p) => (
                      <tr key={p.id} className="hover:bg-[#F9F9F9]">
                        <td className="py-2.5 px-3 font-mono font-medium">{p.actionType}</td>
                        <td className="py-2.5 px-3 font-mono">{p.ticketRef}</td>
                        <td className="py-2.5 px-3 text-[#555]">{p.proposedBy}</td>
                        <td className="py-2.5 px-3 max-w-xs truncate">{p.reason}</td>
                        <td className="py-2.5 px-3">
                          <span
                            className={`px-2 py-0.5 rounded text-[11px] font-semibold ${
                              p.status === "executed"
                                ? "bg-emerald-50 text-emerald-700"
                                : p.status === "pending_approval"
                                ? "bg-amber-50 text-amber-700"
                                : "bg-gray-100 text-gray-700"
                            }`}
                          >
                            {p.status}
                          </span>
                        </td>
                        <td className="py-2.5 px-3 text-right">
                          {p.status === "pending_approval" ? (
                            <button
                              onClick={() => handleApproveProposal(p.id)}
                              className="px-2.5 py-1 bg-emerald-600 hover:bg-emerald-700 text-white rounded text-xs font-medium"
                            >
                              Approve (Staff 2)
                            </button>
                          ) : (
                            <span className="text-[#888] font-mono text-[11px]">Approved by {p.approvedBy || "—"}</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ── Dual-Control Proposal Modal ── */}
      {showDualControlModal && (
        <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-[#F0F0F0] pb-3">
              <h3 className="text-base font-bold text-[#0F0F14] flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-amber-600" />
                Propose Exceptional Corrective Action
              </h3>
              <button
                onClick={() => setShowDualControlModal(false)}
                className="text-[#888] hover:text-[#0F0F14] text-sm"
              >
                ✕
              </button>
            </div>

            <p className="text-xs text-[#666]">
              Dual-Control Requirement: Actions cannot be self-approved. Once submitted, a second authorized staff member
              must verify on-chain evidence before execution.
            </p>

            <form onSubmit={handleProposeAction} className="space-y-4 pt-2">
              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">Action Type</label>
                <select
                  value={actionType}
                  onChange={(e: any) => setActionType(e.target.value)}
                  className="w-full h-10 px-3 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl text-[#0F0F14]"
                >
                  <option value="FORCE_RECONCILE">Force Reconcile against Horizon</option>
                  <option value="MARK_INTENT_FAILED">Mark Expired Intent Cancelled/Failed</option>
                  <option value="FLAG_AMBIGUOUS_INVESTIGATION">Flag for Manual Financial Review</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">
                  Support Ticket Reference (Required)
                </label>
                <input
                  type="text"
                  placeholder="e.g. INC-2026-1021"
                  value={ticketRef}
                  onChange={(e) => setTicketRef(e.target.value)}
                  required
                  className="w-full h-10 px-3 text-xs font-mono bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl text-[#0F0F14]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">
                  Root-Cause Justification (Required)
                </label>
                <textarea
                  placeholder="Document why this corrective action is required and summarize on-chain verification steps taken."
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  required
                  rows={3}
                  className="w-full p-3 text-xs bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl text-[#0F0F14]"
                />
              </div>

              <div className="flex items-center justify-end gap-3 pt-3 border-t border-[#F0F0F0]">
                <button
                  type="button"
                  onClick={() => setShowDualControlModal(false)}
                  className="px-4 py-2 text-xs font-medium text-[#666] hover:text-[#0F0F14]"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={proposing}
                  className="px-4 py-2 bg-[#0F0F14] hover:bg-[#222] text-white text-xs font-medium rounded-xl disabled:opacity-50"
                >
                  {proposing ? "Submitting..." : "Submit for Approval"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
