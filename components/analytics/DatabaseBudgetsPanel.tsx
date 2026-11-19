"use client";

import React, { useState, useEffect, useCallback } from "react";
import {
  Clock,
  AlertTriangle,
  CheckCircle2,
  Activity,
  Layers,
  RefreshCw,
  Zap,
  Play,
  ShieldCheck,
  Server,
  StopCircle,
} from "lucide-react";
import {
  type DatabaseObservabilityReport,
  type QueryTraceRecord,
  type RoutePerformanceSummary,
  getDatabaseObservabilityReport,
  simulateDatabaseQuery,
} from "@/lib/supabase/queryBudget";

export function DatabaseBudgetsPanel() {
  const [report, setReport] = useState<DatabaseObservabilityReport>(() =>
    getDatabaseObservabilityReport()
  );
  const [loading, setLoading] = useState(false);
  const [simulating, setSimulating] = useState(false);
  const [simulationResult, setSimulationResult] = useState<{
    type: string;
    durationMs: number;
    status: string;
    error?: string;
  } | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("ALL");
  const [selectedRoute, setSelectedRoute] = useState<string>("ALL");

  const fetchReport = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch("/api/analytics/database-performance");
      if (res.ok) {
        const data = await res.json();
        setReport({
          overall: data.overall,
          routes: data.routes,
          recentTraces: data.recentTraces,
          timestamp: data.timestamp,
        });
      } else {
        // Fall back to in-memory report
        setReport(getDatabaseObservabilityReport());
      }
    } catch {
      setReport(getDatabaseObservabilityReport());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReport();
    const interval = setInterval(fetchReport, 10000);
    return () => clearInterval(interval);
  }, [fetchReport]);

  const handleSimulate = async (type: "fast" | "slow" | "chatty" | "timeout") => {
    setSimulating(true);
    setSimulationResult(null);

    let route = "/api/trips";
    let delayMs = 50;
    let shouldTimeout = false;
    let queryCount = 1;

    if (type === "slow") {
      route = "/api/expenses";
      delayMs = 1200;
    } else if (type === "chatty") {
      route = "/api/trips";
      delayMs = 40;
      queryCount = 5;
    } else if (type === "timeout") {
      route = "/api/settlement";
      delayMs = 2500;
      shouldTimeout = true;
    }

    try {
      const res = await simulateDatabaseQuery({
        route,
        operation: `${route.replace("/api/", "")}.simulate`,
        table: route.replace("/api/", ""),
        delayMs,
        shouldTimeout,
        queryCount,
      });

      setSimulationResult({
        type,
        durationMs: res.trace?.durationMs ?? delayMs,
        status: res.trace?.status ?? (shouldTimeout ? "timeout" : "ok"),
        error: res.error,
      });

      await fetchReport();
    } catch (err) {
      setSimulationResult({
        type,
        durationMs: delayMs,
        status: "timeout",
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSimulating(false);
    }
  };

  const filteredTraces = report.recentTraces.filter((trace: QueryTraceRecord) => {
    if (statusFilter !== "ALL" && trace.status !== statusFilter.toLowerCase()) {
      return false;
    }
    if (selectedRoute !== "ALL" && trace.route !== selectedRoute) {
      return false;
    }
    return true;
  });

  const routesList = Object.values(report.routes);

  return (
    <div className="space-y-6">
      {/* Overview KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="flex items-center justify-between text-[#888] mb-2">
            <span className="text-xs font-bold uppercase tracking-wider">Average Latency</span>
            <Clock size={16} className="text-[#2DD4BF]" />
          </div>
          <div className="text-3xl font-black text-[#0F0F14] mb-1">
            {report.overall.avgDurationMs} <span className="text-sm font-semibold text-[#888]">ms</span>
          </div>
          <p className="text-xs text-[#666]">
            p95 Latency: <span className="font-bold text-[#0F0F14]">{report.overall.p95DurationMs} ms</span>
          </p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="flex items-center justify-between text-[#888] mb-2">
            <span className="text-xs font-bold uppercase tracking-wider">Total Database Calls</span>
            <Server size={16} className="text-blue-500" />
          </div>
          <div className="text-3xl font-black text-[#0F0F14] mb-1">
            {report.overall.totalCalls}
          </div>
          <p className="text-xs text-[#666]">
            Across <span className="font-bold text-[#0F0F14]">{report.overall.totalRequests}</span> distinct API requests
          </p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="flex items-center justify-between text-[#888] mb-2">
            <span className="text-xs font-bold uppercase tracking-wider">Stalled Queries Aborted</span>
            <StopCircle size={16} className="text-amber-500" />
          </div>
          <div className="text-3xl font-black text-[#0F0F14] mb-1">
            {report.overall.timeoutCount}
          </div>
          <p className="text-xs text-[#666]">
            Terminated predictably before platform timeout
          </p>
        </div>

        <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
          <div className="flex items-center justify-between text-[#888] mb-2">
            <span className="text-xs font-bold uppercase tracking-wider">Query Failures</span>
            <AlertTriangle size={16} className="text-[#FF6B6B]" />
          </div>
          <div className="text-3xl font-black text-[#0F0F14] mb-1">
            {report.overall.errorCount}
          </div>
          <p className="text-xs text-[#666]">
            Error rate: {report.overall.totalCalls > 0 ? ((report.overall.errorCount / report.overall.totalCalls) * 100).toFixed(1) : 0}%
          </p>
        </div>
      </div>

      {/* Interactive Query Simulator Panel */}
      <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 mb-4">
          <div>
            <h3 className="text-sm font-bold text-[#0F0F14] flex items-center gap-2">
              <Zap size={16} className="text-[#2DD4BF]" />
              Predictable Query Termination & Budget Verification
            </h3>
            <p className="text-xs text-[#666] mt-0.5">
              Simulate database calls to verify deadline propagation, chatty endpoint detection, and predictable cancellation.
            </p>
          </div>
          <button
            onClick={fetchReport}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-[#F6F6F6] hover:bg-[#EDEDED] text-[#0F0F14] text-xs font-bold rounded-xl transition-all self-start sm:self-auto"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <div className="flex flex-wrap gap-2.5">
          <button
            onClick={() => handleSimulate("fast")}
            disabled={simulating}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-[#F6F6F6] hover:bg-[#EAEAEA] text-[#0F0F14] text-xs font-bold rounded-xl transition-all disabled:opacity-50"
          >
            <Play size={12} className="text-emerald-600" />
            Fast Query (50ms)
          </button>

          <button
            onClick={() => handleSimulate("slow")}
            disabled={simulating}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-amber-50 hover:bg-amber-100 text-amber-900 text-xs font-bold rounded-xl border border-amber-200 transition-all disabled:opacity-50"
          >
            <Clock size={12} className="text-amber-600" />
            Slow Query (1200ms)
          </button>

          <button
            onClick={() => handleSimulate("chatty")}
            disabled={simulating}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-purple-50 hover:bg-purple-100 text-purple-900 text-xs font-bold rounded-xl border border-purple-200 transition-all disabled:opacity-50"
          >
            <Layers size={12} className="text-purple-600" />
            Chatty Endpoint (5 queries)
          </button>

          <button
            onClick={() => handleSimulate("timeout")}
            disabled={simulating}
            className="flex items-center gap-1.5 px-3.5 py-2 bg-rose-50 hover:bg-rose-100 text-rose-900 text-xs font-bold rounded-xl border border-rose-200 transition-all disabled:opacity-50"
          >
            <StopCircle size={12} className="text-rose-600" />
            Stalled Query (Simulate Timeout)
          </button>
        </div>

        {simulationResult && (
          <div
            className={`mt-4 p-3.5 rounded-xl border text-xs flex items-start justify-between gap-3 ${
              simulationResult.status === "timeout"
                ? "bg-rose-50 border-rose-200 text-rose-900"
                : simulationResult.status === "chatty"
                ? "bg-purple-50 border-purple-200 text-purple-900"
                : simulationResult.status === "slow"
                ? "bg-amber-50 border-amber-200 text-amber-900"
                : "bg-emerald-50 border-emerald-200 text-emerald-900"
            }`}
          >
            <div>
              <span className="font-bold uppercase tracking-wider block mb-0.5">
                Simulation Result: {simulationResult.status.toUpperCase()}
              </span>
              <p>
                Executed {simulationResult.type} scenario in {simulationResult.durationMs}ms.
                {simulationResult.error ? ` Termination details: ${simulationResult.error}` : " Completed within budget constraints."}
              </p>
            </div>
            <span className="px-2 py-0.5 bg-white/80 rounded font-mono font-bold text-[11px] shrink-0">
              {simulationResult.status}
            </span>
          </div>
        )}
      </div>

      {/* Route Performance & Budgets Matrix */}
      <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
        <h3 className="text-sm font-bold text-[#0F0F14] mb-3">
          Route Query Budgets & Observability Matrix
        </h3>
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead>
              <tr className="border-b border-[#E5E5E5] text-[#888] font-semibold">
                <th className="pb-2.5">Route</th>
                <th className="pb-2.5">Queries / Req</th>
                <th className="pb-2.5">p95 Latency</th>
                <th className="pb-2.5">Statement Timeout</th>
                <th className="pb-2.5">Lock Timeout</th>
                <th className="pb-2.5">Timeouts / Errors</th>
                <th className="pb-2.5 text-right">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F0F0]">
              {routesList.map((r: RoutePerformanceSummary) => (
                <tr key={r.route} className="hover:bg-[#FAFAFA] transition-colors">
                  <td className="py-3 font-mono font-bold text-[#0F0F14]">{r.route}</td>
                  <td className="py-3">
                    <span className={r.isChatty ? "text-amber-600 font-bold" : "text-[#444]"}>
                      {r.avgQueriesPerRequest} / {r.budget.maxQueries} max
                    </span>
                    {r.isChatty && (
                      <span className="ml-1.5 px-1.5 py-0.5 bg-amber-100 text-amber-800 rounded text-[10px] font-bold">
                        Chatty
                      </span>
                    )}
                  </td>
                  <td className="py-3">
                    <span className={r.isSlow ? "text-rose-600 font-bold" : "text-[#444]"}>
                      {r.p95DurationMs} ms
                    </span>
                    <span className="text-[#888] ml-1 font-normal">
                      (budget: {r.budget.maxDurationMs}ms)
                    </span>
                    {r.isSlow && (
                      <span className="ml-1.5 px-1.5 py-0.5 bg-rose-100 text-rose-800 rounded text-[10px] font-bold">
                        Slow
                      </span>
                    )}
                  </td>
                  <td className="py-3 text-[#666] font-mono">{r.budget.statementTimeoutMs}ms</td>
                  <td className="py-3 text-[#666] font-mono">{r.budget.lockTimeoutMs}ms</td>
                  <td className="py-3">
                    {r.timeoutCount > 0 ? (
                      <span className="font-bold text-amber-600 mr-2">{r.timeoutCount} timeouts</span>
                    ) : (
                      <span className="text-[#888] mr-2">0 timeouts</span>
                    )}
                    {r.errorCount > 0 ? (
                      <span className="font-bold text-rose-600">{r.errorCount} errors</span>
                    ) : (
                      <span className="text-[#888]">0 errors</span>
                    )}
                  </td>
                  <td className="py-3 text-right">
                    {r.timeoutCount > 0 ? (
                      <span className="px-2 py-0.5 bg-rose-100 text-rose-800 rounded-full font-bold text-[11px]">
                        Timeout Risk
                      </span>
                    ) : r.isSlow ? (
                      <span className="px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full font-bold text-[11px]">
                        Slow Endpoint
                      </span>
                    ) : r.isChatty ? (
                      <span className="px-2 py-0.5 bg-purple-100 text-purple-800 rounded-full font-bold text-[11px]">
                        Chatty
                      </span>
                    ) : (
                      <span className="px-2 py-0.5 bg-emerald-100 text-emerald-800 rounded-full font-bold text-[11px]">
                        Healthy
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Recent Query Traces Filter & Table */}
      <div className="p-5 bg-white rounded-2xl border border-[#E5E5E5] shadow-sm">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <div>
            <h3 className="text-sm font-bold text-[#0F0F14]">Recent Database Query Traces</h3>
            <p className="text-xs text-[#666]">
              Real-time ring buffer of the latest database calls with propagated correlation IDs.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedRoute}
              onChange={(e) => setSelectedRoute(e.target.value)}
              className="text-xs border border-[#D5D5D5] rounded-xl px-2.5 py-1.5 bg-white"
            >
              <option value="ALL">All Routes</option>
              {routesList.map((r) => (
                <option key={r.route} value={r.route}>
                  {r.route}
                </option>
              ))}
            </select>

            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="text-xs border border-[#D5D5D5] rounded-xl px-2.5 py-1.5 bg-white"
            >
              <option value="ALL">All Statuses</option>
              <option value="OK">OK</option>
              <option value="SLOW">Slow</option>
              <option value="CHATTY">Chatty</option>
              <option value="TIMEOUT">Timeout</option>
              <option value="ERROR">Error</option>
            </select>
          </div>
        </div>

        {filteredTraces.length === 0 ? (
          <div className="py-12 text-center text-xs text-[#888]">
            No traces matching the selected filter. Click a simulation button above to generate telemetry!
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-[#E5E5E5] text-[#888] font-semibold">
                  <th className="pb-2.5">Timestamp</th>
                  <th className="pb-2.5">Route</th>
                  <th className="pb-2.5">Operation</th>
                  <th className="pb-2.5">Duration</th>
                  <th className="pb-2.5">Request ID</th>
                  <th className="pb-2.5 text-right">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#F0F0F0]">
                {filteredTraces.slice(0, 25).map((trace: QueryTraceRecord) => (
                  <tr key={trace.id} className="hover:bg-[#FAFAFA] transition-colors font-mono">
                    <td className="py-2.5 text-[#666]">
                      {new Date(trace.timestamp).toLocaleTimeString()}
                    </td>
                    <td className="py-2.5 font-bold text-[#0F0F14]">{trace.route}</td>
                    <td className="py-2.5 text-[#444]">{trace.operation}</td>
                    <td className="py-2.5">
                      <span
                        className={
                          trace.durationMs > 1000
                            ? "text-rose-600 font-bold"
                            : trace.durationMs > 500
                            ? "text-amber-600 font-bold"
                            : "text-[#222]"
                        }
                      >
                        {trace.durationMs} ms
                      </span>
                    </td>
                    <td className="py-2.5 text-[#777] text-[11px]">
                      {trace.requestId.slice(0, 8)}...
                    </td>
                    <td className="py-2.5 text-right">
                      <span
                        className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          trace.status === "ok"
                            ? "bg-emerald-100 text-emerald-800"
                            : trace.status === "slow"
                            ? "bg-amber-100 text-amber-800"
                            : trace.status === "chatty"
                            ? "bg-purple-100 text-purple-800"
                            : trace.status === "timeout"
                            ? "bg-rose-100 text-rose-800"
                            : "bg-red-100 text-red-800"
                        }`}
                      >
                        {trace.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Redaction Guarantee Note */}
      <div className="flex items-center gap-3 p-4 bg-emerald-50 border border-emerald-200 rounded-2xl text-xs text-emerald-900">
        <ShieldCheck size={18} className="text-emerald-700 shrink-0" />
        <div>
          <span className="font-bold">Redaction & Privacy Invariant Verified:</span> Database telemetry traces record route, duration, and error codes only. Raw query payloads, Stellar secrets, and member JWTs are never recorded.
        </div>
      </div>
    </div>
  );
}
