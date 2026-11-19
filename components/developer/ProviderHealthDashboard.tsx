"use client";

import React, { useState, useEffect } from "react";
import {
  Server,
  Activity,
  RefreshCw,
  Power,
  Shield,
  AlertTriangle,
  CheckCircle,
  Clock,
  Layers,
  ArrowRight,
} from "lucide-react";
import { useToast } from "@/components/ui/Toast";

interface ProviderData {
  id: string;
  name: string;
  domain: string;
  priority: number;
  capabilities: string[];
  health: "healthy" | "degraded" | "unhealthy" | "disabled";
  disabled: boolean;
  averageLatencyMs: number;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  totalRequests: number;
  totalFailures: number;
  endpointUrl?: string;
  lastHealthCheck?: {
    healthy: boolean;
    latencyMs: number;
    message?: string;
    timestamp: number;
  };
}

export function ProviderHealthDashboard() {
  const { success, error, info } = useToast();
  const [providers, setProviders] = useState<ProviderData[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingOn, setActingOn] = useState<string | null>(null);

  const fetchProviders = async () => {
    try {
      const res = await fetch("/api/developer/providers");
      if (res.ok) {
        const data = await res.json();
        setProviders(data.providers || []);
      }
    } catch {
      error("Network Error", "Could not load provider health records.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchProviders();
    const interval = setInterval(fetchProviders, 15000);
    return () => clearInterval(interval);
  }, []);

  const handleToggle = async (provider: ProviderData) => {
    setActingOn(provider.id);
    const nextDisabled = !provider.disabled;
    try {
      const res = await fetch("/api/developer/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "toggle",
          providerId: provider.id,
          disabled: nextDisabled,
        }),
      });
      if (res.ok) {
        success(
          nextDisabled ? "Provider Disabled" : "Provider Enabled",
          `Traffic will ${nextDisabled ? "failover to backup" : "resume routing through this vendor"}.`,
        );
        fetchProviders();
      } else {
        error("Action Failed", "Could not update provider status.");
      }
    } catch {
      error("Action Failed", "Network error updating provider.");
    } finally {
      setActingOn(null);
    }
  };

  const handleHealthCheck = async (providerId?: string) => {
    setActingOn(providerId || "all");
    try {
      const res = await fetch("/api/developer/providers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "check",
          providerId,
        }),
      });
      if (res.ok) {
        info("Health Check Complete", "Provider probes refreshed successfully.");
        fetchProviders();
      }
    } catch {
      error("Check Failed", "Could not complete health check.");
    } finally {
      setActingOn(null);
    }
  };

  const getStatusBadge = (health: string) => {
    switch (health) {
      case "healthy":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-50 text-emerald-700 border border-emerald-200">
            <CheckCircle className="w-3.5 h-3.5 text-emerald-500" />
            Healthy
          </span>
        );
      case "degraded":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
            <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
            Degraded
          </span>
        );
      case "unhealthy":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-rose-50 text-rose-700 border border-rose-200">
            <AlertTriangle className="w-3.5 h-3.5 text-rose-500" />
            Unhealthy
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600 border border-zinc-200">
            <Power className="w-3.5 h-3.5 text-zinc-400" />
            Disabled
          </span>
        );
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-zinc-200 pb-6">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2 bg-indigo-50 text-indigo-600 rounded-lg border border-indigo-100">
              <Server className="w-6 h-6" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-zinc-900 tracking-tight">
                Provider Health & Routing
              </h1>
              <p className="text-sm text-zinc-500 mt-0.5">
                Multi-vendor failover routing across Stellar, FX, OCR, and Notification relays (#428).
              </p>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => handleHealthCheck()}
            disabled={actingOn !== null}
            className="inline-flex items-center gap-2 px-3.5 py-2 text-sm font-medium text-zinc-700 bg-white border border-zinc-300 rounded-lg hover:bg-zinc-50 transition shadow-sm disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${actingOn === "all" ? "animate-spin" : ""}`} />
            Check All Health
          </button>
        </div>
      </div>

      {/* Domain Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {["stellar", "fx", "ocr", "notification"].map((domain) => {
          const domainProviders = providers.filter((p) => p.domain === domain);
          const healthyCount = domainProviders.filter((p) => p.health === "healthy").length;
          const isFullHealth = healthyCount === domainProviders.length && domainProviders.length > 0;

          return (
            <div key={domain} className="p-4 bg-white rounded-xl border border-zinc-200 shadow-sm space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                  {domain}
                </span>
                <span className={`w-2.5 h-2.5 rounded-full ${isFullHealth ? "bg-emerald-500" : "bg-amber-500"}`} />
              </div>
              <div className="text-xl font-bold text-zinc-900 capitalize">
                {domain === "fx" ? "Foreign Exchange" : domain}
              </div>
              <p className="text-xs text-zinc-500">
                {healthyCount} of {domainProviders.length} providers operational
              </p>
            </div>
          );
        })}
      </div>

      {/* Provider Table */}
      <div className="bg-white rounded-xl border border-zinc-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-200 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-900 flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-600" />
            Configured Vendor Hierarchy & Failover State
          </h2>
          <span className="text-xs text-zinc-400">Auto-refreshes every 15s</span>
        </div>

        {loading ? (
          <div className="p-12 text-center text-sm text-zinc-500">Loading vendor status...</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm text-zinc-600">
              <thead className="bg-zinc-50 text-xs uppercase tracking-wider text-zinc-500 border-b border-zinc-200">
                <tr>
                  <th className="px-6 py-3.5 font-medium">Provider</th>
                  <th className="px-6 py-3.5 font-medium">Domain</th>
                  <th className="px-6 py-3.5 font-medium">Priority</th>
                  <th className="px-6 py-3.5 font-medium">Status</th>
                  <th className="px-6 py-3.5 font-medium">Latency</th>
                  <th className="px-6 py-3.5 font-medium">Capabilities</th>
                  <th className="px-6 py-3.5 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {providers.map((p) => (
                  <tr key={p.id} className="hover:bg-zinc-50/50 transition">
                    <td className="px-6 py-4">
                      <div className="font-medium text-zinc-900">{p.name}</div>
                      <div className="text-xs text-zinc-400 font-mono mt-0.5">{p.id}</div>
                    </td>
                    <td className="px-6 py-4 capitalize font-medium text-zinc-700">{p.domain}</td>
                    <td className="px-6 py-4">
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-zinc-100 text-zinc-700">
                        P{p.priority} {p.priority === 1 ? "(Primary)" : "(Fallback)"}
                      </span>
                    </td>
                    <td className="px-6 py-4">{getStatusBadge(p.health)}</td>
                    <td className="px-6 py-4 text-xs font-mono text-zinc-600">
                      {p.averageLatencyMs > 0 ? `${p.averageLatencyMs}ms` : "—"}
                    </td>
                    <td className="px-6 py-4">
                      <div className="flex flex-wrap gap-1">
                        {p.capabilities.map((cap) => (
                          <span
                            key={cap}
                            className={`px-1.5 py-0.5 rounded text-[11px] font-mono ${
                              cap === "stellar:submit"
                                ? "bg-amber-100 text-amber-800 font-semibold border border-amber-200"
                                : "bg-zinc-100 text-zinc-600"
                            }`}
                          >
                            {cap}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-6 py-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => handleHealthCheck(p.id)}
                          disabled={actingOn !== null}
                          title="Probe health"
                          className="p-1.5 text-zinc-500 hover:text-zinc-800 hover:bg-zinc-100 rounded transition"
                        >
                          <RefreshCw className={`w-4 h-4 ${actingOn === p.id ? "animate-spin" : ""}`} />
                        </button>
                        <button
                          onClick={() => handleToggle(p)}
                          disabled={actingOn !== null}
                          className={`px-2.5 py-1 text-xs font-medium rounded-lg border transition ${
                            p.disabled
                              ? "bg-emerald-50 text-emerald-700 border-emerald-300 hover:bg-emerald-100"
                              : "bg-rose-50 text-rose-700 border-rose-300 hover:bg-rose-100"
                          }`}
                        >
                          {p.disabled ? "Enable" : "Disable"}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
