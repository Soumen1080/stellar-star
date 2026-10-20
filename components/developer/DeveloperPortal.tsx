"use client";

import React, { useState, useEffect } from "react";
import {
  Key,
  Webhook,
  BookOpen,
  ShieldCheck,
  Send,
  Trash2,
  Copy,
  Check,
  RefreshCw,
  Clock,
  Layers,
  ArrowRight,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useToast } from "@/components/ui/Toast";
import { OPENAPI_SPEC, ACCOUNTING_SANDBOX_MAPPINGS } from "@/lib/api/openapi";
import type { ApiScope, ApiTokenRecord, WebhookEndpoint, WebhookDeliveryLog } from "@/lib/api/types";

type Tab = "overview" | "tokens" | "webhooks" | "openapi" | "sandbox";

export function DeveloperPortal() {
  const { publicKey } = useWallet();
  const { success, error, info } = useToast();

  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [tokens, setTokens] = useState<ApiTokenRecord[]>([]);
  const [webhooks, setWebhooks] = useState<WebhookEndpoint[]>([]);
  const [deliveries, setDeliveries] = useState<WebhookDeliveryLog[]>([]);
  const [loading, setLoading] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  // New token form state
  const [tokenName, setTokenName] = useState("");
  const [selectedScopes, setSelectedScopes] = useState<ApiScope[]>([
    "trips:read",
    "expenses:read",
  ]);
  const [newlyMintedToken, setNewlyMintedToken] = useState<string | null>(null);

  // New webhook form state
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookDesc, setWebhookDesc] = useState("");
  const [testingWebhookId, setTestingWebhookId] = useState<string | null>(null);

  const activeWallet = publicKey || "GDEMO_DEVELOPER_PUBLIC_KEY_TESTNET123456789";

  const copyToClipboard = (text: string, id: string) => {
    navigator.clipboard?.writeText(text);
    setCopiedKey(id);
    success("Copied to clipboard", text.slice(0, 24) + "...");
    setTimeout(() => setCopiedKey(null), 2500);
  };

  const handleMintToken = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tokenName.trim()) {
      error("Token name required", "Please enter a descriptive name for your application.");
      return;
    }

    try {
      setLoading(true);
      const res = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-wallet-address": activeWallet,
        },
        body: JSON.stringify({
          name: tokenName.trim(),
          scopes: selectedScopes,
          wallet_address: activeWallet,
        }),
      });

      const json = await res.json();
      if (res.ok && json.data) {
        setNewlyMintedToken(json.data.token);
        setTokens((prev) => [json.data, ...prev]);
        setTokenName("");
        success("Token minted successfully", "Copy your token now. It will not be shown again in full.");
      } else {
        error("Mint failed", json.error?.message || "Could not generate token.");
      }
    } catch {
      error("Network error", "Unable to reach token service.");
    } finally {
      setLoading(false);
    }
  };

  const handleRegisterWebhook = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!webhookUrl.trim()) return;

    try {
      setLoading(true);
      const tokenRes = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": activeWallet },
        body: JSON.stringify({ name: "Webhook Admin", scopes: ["webhooks:manage"], wallet_address: activeWallet }),
      });
      const tokenJson = await tokenRes.json();
      const bearer = tokenJson.data?.token;

      const res = await fetch("/api/v1/webhooks", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({
          url: webhookUrl.trim(),
          description: webhookDesc.trim() || undefined,
          events: ["trip.created", "expense.created", "settlement.completed"],
        }),
      });

      const json = await res.json();
      if (res.ok && json.data) {
        setWebhooks((prev) => [json.data, ...prev]);
        setWebhookUrl("");
        setWebhookDesc("");
        success("Webhook registered", "Signing secret generated. Configure HMAC verification on your server.");
      } else {
        error("Registration failed", json.error?.message || "Invalid webhook parameters.");
      }
    } catch {
      error("Network error", "Failed to register webhook.");
    } finally {
      setLoading(false);
    }
  };

  const handleTestWebhook = async (webhookId: string) => {
    try {
      setTestingWebhookId(webhookId);
      const tokenRes = await fetch("/api/v1/tokens", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-wallet-address": activeWallet },
        body: JSON.stringify({ name: "Webhook Tester", scopes: ["webhooks:manage"], wallet_address: activeWallet }),
      });
      const tokenJson = await tokenRes.json();
      const bearer = tokenJson.data?.token;

      const res = await fetch("/api/v1/webhooks/test", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${bearer}`,
        },
        body: JSON.stringify({ webhook_id: webhookId }),
      });

      const json = await res.json();
      if (res.ok && json.data) {
        setDeliveries((prev) => [json.data, ...prev]);
        if (json.data.success) {
          success("Ping delivered!", `HTTP ${json.data.statusCode} in ${json.data.latencyMs}ms`);
        } else {
          info("Ping recorded", json.data.error || "Endpoint did not return 2xx status.");
        }
      }
    } catch {
      error("Test failed", "Unable to execute webhook ping.");
    } finally {
      setTestingWebhookId(null);
    }
  };

  return (
    <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
      {/* Platform Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-[#EBEBEB] pb-6">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-[#0F0F14] text-[#2DD4BF] text-xs font-semibold uppercase tracking-wider mb-2">
            <ShieldCheck size={13} />
            Developer Platform v1
          </div>
          <h1 className="text-3xl font-extrabold text-[#0F0F14] tracking-tight">
            Developer API & Webhook Framework
          </h1>
          <p className="text-sm text-[#666] mt-1 max-w-2xl">
            Integrate accounting systems, event platforms, and ERP workflows safely without exposing raw Supabase service keys.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <a
            href="/api/v1/openapi.json"
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-[#F5F5F5] text-[#333] hover:bg-[#EBEBEB] transition-all"
          >
            <BookOpen size={13} />
            Raw OpenAPI 3.1 JSON
          </a>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-2 p-1.5 bg-[#EBEBEB] rounded-2xl w-fit flex-wrap">
        {[
          { id: "overview", label: "Overview & Auth", icon: ShieldCheck },
          { id: "tokens", label: "Scoped Tokens", icon: Key },
          { id: "webhooks", label: "Webhooks", icon: Webhook },
          { id: "openapi", label: "API Reference", icon: BookOpen },
          { id: "sandbox", label: "Accounting Sandbox", icon: Layers },
        ].map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id as Tab)}
              className={`flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition-all ${
                activeTab === tab.id
                  ? "bg-white text-[#0F0F14] shadow-sm font-bold"
                  : "text-[#666] hover:text-[#0F0F14]"
              }`}
            >
              <Icon size={14} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Tab: Overview */}
      {activeTab === "overview" && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="p-5 rounded-2xl border border-[#E5E5E5] bg-white">
              <div className="w-8 h-8 rounded-lg bg-teal-50 text-teal-600 flex items-center justify-center mb-3">
                <Key size={16} />
              </div>
              <h3 className="text-sm font-bold text-[#0F0F14]">Scoped Tokens</h3>
              <p className="text-xs text-[#666] mt-1 leading-relaxed">
                Granular permissions (`trips:read`, `expenses:write`, `webhooks:manage`). Never exposes raw Supabase service keys.
              </p>
            </div>
            <div className="p-5 rounded-2xl border border-[#E5E5E5] bg-white">
              <div className="w-8 h-8 rounded-lg bg-purple-50 text-purple-600 flex items-center justify-center mb-3">
                <Clock size={16} />
              </div>
              <h3 className="text-sm font-bold text-[#0F0F14]">Idempotency & Rate Limits</h3>
              <p className="text-xs text-[#666] mt-1 leading-relaxed">
                Pass `Idempotency-Key: &lt;uuid&gt;` on writes to prevent double-charges. 60 requests/min rate limit with standard headers.
              </p>
            </div>
            <div className="p-5 rounded-2xl border border-[#E5E5E5] bg-white">
              <div className="w-8 h-8 rounded-lg bg-emerald-50 text-emerald-600 flex items-center justify-center mb-3">
                <Webhook size={16} />
              </div>
              <h3 className="text-sm font-bold text-[#0F0F14]">Signed Webhooks</h3>
              <p className="text-xs text-[#666] mt-1 leading-relaxed">
                HMAC-SHA256 signatures with 300s replay attack tolerance, delivery logs, and automatic exponential retries.
              </p>
            </div>
          </div>

          {/* Quickstart Code */}
          <div className="p-6 rounded-2xl bg-[#0F0F14] text-white space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-mono text-[#2DD4BF]">Quickstart Example: Fetch Trips</span>
              <button
                onClick={() =>
                  copyToClipboard(
                    `curl -H "Authorization: Bearer stk_live_YOUR_TOKEN" https://stellarstar.app/api/v1/trips`,
                    "curl-snippet"
                  )
                }
                className="flex items-center gap-1 text-xs text-[#888] hover:text-white transition-colors"
              >
                {copiedKey === "curl-snippet" ? <Check size={12} className="text-teal-400" /> : <Copy size={12} />}
                Copy cURL
              </button>
            </div>
            <pre className="text-xs font-mono text-gray-300 overflow-x-auto p-4 rounded-xl bg-black/40">
{`curl -X GET "https://stellarstar.app/api/v1/trips?limit=20" \\
  -H "Authorization: Bearer stk_live_YOUR_SCOPED_TOKEN" \\
  -H "Accept: application/json"`}
            </pre>
          </div>
        </div>
      )}

      {/* Tab: Scoped Tokens */}
      {activeTab === "tokens" && (
        <div className="space-y-6">
          <form onSubmit={handleMintToken} className="p-6 rounded-2xl border border-[#E5E5E5] bg-white space-y-4">
            <h2 className="text-base font-bold text-[#0F0F14]">Mint New Scoped Token</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">Application Name</label>
                <input
                  type="text"
                  placeholder="e.g. QuickBooks Live Sync"
                  value={tokenName}
                  onChange={(e) => setTokenName(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#DDD] text-sm focus:border-black outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">Active Wallet Address</label>
                <input
                  type="text"
                  readOnly
                  value={activeWallet}
                  className="w-full px-3 py-2 rounded-xl border border-[#EEE] bg-[#FAFAFA] text-xs font-mono text-[#666]"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-[#444] mb-2">Select Permitted Scopes</label>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {[
                  { scope: "trips:read", label: "trips:read (View Trips)" },
                  { scope: "trips:write", label: "trips:write (Create Trips)" },
                  { scope: "expenses:read", label: "expenses:read (View Expenses)" },
                  { scope: "expenses:write", label: "expenses:write (Add Expenses)" },
                  { scope: "settlement:read", label: "settlement:read (Proofs)" },
                  { scope: "webhooks:manage", label: "webhooks:manage (Webhooks)" },
                ].map(({ scope, label }) => {
                  const checked = selectedScopes.includes(scope as ApiScope);
                  return (
                    <label
                      key={scope}
                      className={`flex items-center gap-2 p-2.5 rounded-xl border text-xs cursor-pointer transition-all ${
                        checked ? "bg-teal-50/50 border-teal-300 text-teal-900 font-semibold" : "border-[#E5E5E5] text-[#666]"
                      }`}
                    >
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => {
                          setSelectedScopes((prev) =>
                            prev.includes(scope as ApiScope)
                              ? prev.filter((s) => s !== scope)
                              : [...prev, scope as ApiScope]
                          );
                        }}
                        className="rounded accent-teal-600"
                      />
                      <span>{label}</span>
                    </label>
                  );
                })}
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="px-5 py-2.5 rounded-xl bg-[#0F0F14] text-white text-xs font-bold hover:bg-black transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Key size={14} />
              Generate Scoped Token
            </button>
          </form>

          {newlyMintedToken && (
            <div className="p-5 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-amber-800">Token Generated (Copy Now)</span>
              <div className="flex items-center justify-between gap-2 p-3 bg-white rounded-xl border border-amber-200">
                <code className="text-xs font-mono break-all text-[#0F0F14]">{newlyMintedToken}</code>
                <button
                  onClick={() => copyToClipboard(newlyMintedToken, "new-token")}
                  className="px-3 py-1.5 rounded-lg bg-[#0F0F14] text-white text-xs font-semibold shrink-0"
                >
                  Copy
                </button>
              </div>
              <p className="text-[11px] text-amber-700">
                For security, this token will never be displayed in full again. Store it securely in your integration environment.
              </p>
            </div>
          )}

          {tokens.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-[#0F0F14]">Active Tokens</h3>
              <div className="space-y-2">
                {tokens.map((token) => (
                  <div key={token.tokenId} className="p-4 rounded-xl border border-[#E5E5E5] bg-white flex items-center justify-between">
                    <div>
                      <p className="text-xs font-bold text-[#0F0F14]">{token.name}</p>
                      <p className="text-[11px] font-mono text-[#888]">{token.tokenMasked}</p>
                      <div className="flex gap-1 mt-1">
                        {token.scopes.map((s) => (
                          <span key={s} className="px-2 py-0.5 rounded bg-[#F5F5F5] text-[10px] text-[#555] font-mono">
                            {s}
                          </span>
                        ))}
                      </div>
                    </div>
                    <span className="text-xs text-emerald-600 font-semibold px-2 py-0.5 rounded-full bg-emerald-50">
                      Active
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab: Webhooks */}
      {activeTab === "webhooks" && (
        <div className="space-y-6">
          <form onSubmit={handleRegisterWebhook} className="p-6 rounded-2xl border border-[#E5E5E5] bg-white space-y-4">
            <h2 className="text-base font-bold text-[#0F0F14]">Register Webhook Endpoint</h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">Destination URL (HTTPS)</label>
                <input
                  type="url"
                  placeholder="https://accounting.yourdomain.com/webhooks"
                  value={webhookUrl}
                  onChange={(e) => setWebhookUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#DDD] text-sm focus:border-black outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-[#444] mb-1">Description (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. ERP Ingestion Service"
                  value={webhookDesc}
                  onChange={(e) => setWebhookDesc(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl border border-[#DDD] text-sm focus:border-black outline-none"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading || !webhookUrl}
              className="px-5 py-2.5 rounded-xl bg-[#0F0F14] text-white text-xs font-bold hover:bg-black transition-all flex items-center gap-2 disabled:opacity-50"
            >
              <Webhook size={14} />
              Register Webhook
            </button>
          </form>

          {webhooks.length > 0 && (
            <div className="space-y-4">
              <h3 className="text-sm font-bold text-[#0F0F14]">Configured Webhooks</h3>
              <div className="space-y-3">
                {webhooks.map((ep) => (
                  <div key={ep.id} className="p-4 rounded-xl border border-[#E5E5E5] bg-white space-y-3">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-xs font-bold text-[#0F0F14]">{ep.description || "Webhook Endpoint"}</p>
                        <p className="text-xs font-mono text-[#666]">{ep.url}</p>
                      </div>
                      <button
                        onClick={() => handleTestWebhook(ep.id)}
                        disabled={testingWebhookId === ep.id}
                        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-[#DDD] text-xs font-semibold hover:border-black transition-colors"
                      >
                        <Send size={12} />
                        {testingWebhookId === ep.id ? "Pinging..." : "Test Ping"}
                      </button>
                    </div>
                    <div className="p-2.5 rounded-lg bg-[#FAFAFA] border border-[#EEE] flex items-center justify-between text-xs font-mono">
                      <span className="text-[#888]">Secret: {ep.secret.slice(0, 10)}...</span>
                      <button
                        onClick={() => copyToClipboard(ep.secret, ep.id)}
                        className="text-teal-700 hover:text-black font-semibold text-[11px]"
                      >
                        Copy Secret
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {deliveries.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-sm font-bold text-[#0F0F14]">Recent Delivery Telemetry</h3>
              <div className="space-y-2">
                {deliveries.map((d) => (
                  <div key={d.id} className="p-3 rounded-xl border border-[#E5E5E5] bg-white flex items-center justify-between text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded font-mono font-bold ${d.success ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                        {d.statusCode ? `HTTP ${d.statusCode}` : "ERR"}
                      </span>
                      <span className="font-semibold text-[#0F0F14]">{d.event}</span>
                    </div>
                    <span className="text-[#888] font-mono">{d.latencyMs}ms</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab: OpenAPI Specification */}
      {activeTab === "openapi" && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl border border-[#E5E5E5] bg-white space-y-4">
            <h2 className="text-base font-bold text-[#0F0F14]">Interactive API Route Directory</h2>
            <div className="space-y-3">
              {Object.entries(OPENAPI_SPEC.paths).map(([path, methods]: any) => (
                <div key={path} className="p-4 rounded-xl border border-[#EEE] bg-[#FAFAFA] space-y-2">
                  <div className="flex items-center gap-2">
                    {methods.get && (
                      <span className="px-2 py-0.5 rounded bg-blue-100 text-blue-700 font-mono text-[10px] font-bold">
                        GET
                      </span>
                    )}
                    {methods.post && (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-mono text-[10px] font-bold">
                        POST
                      </span>
                    )}
                    {methods.delete && (
                      <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-mono text-[10px] font-bold">
                        DELETE
                      </span>
                    )}
                    <span className="font-mono text-xs font-bold text-[#0F0F14]">{path}</span>
                  </div>
                  <p className="text-xs text-[#666]">
                    {methods.get?.summary || methods.post?.summary || methods.delete?.summary}
                  </p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Accounting Sandbox */}
      {activeTab === "sandbox" && (
        <div className="space-y-6">
          <div className="p-6 rounded-2xl border border-[#E5E5E5] bg-white space-y-4">
            <h2 className="text-base font-bold text-[#0F0F14]">QuickBooks & Xero ERP Mappings</h2>
            <p className="text-xs text-[#666]">
              Pre-built mappings transforming StellarStar settlement events directly into double-entry accounting records.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="p-4 rounded-xl border border-[#E5E5E5] bg-[#0F0F14] text-white space-y-2">
                <span className="text-xs font-mono text-[#2DD4BF]">QuickBooks Online (JournalEntry)</span>
                <pre className="text-[11px] font-mono text-gray-300 overflow-x-auto p-3 rounded-lg bg-black/40">
                  {JSON.stringify(ACCOUNTING_SANDBOX_MAPPINGS.quickbooks.example, null, 2)}
                </pre>
              </div>
              <div className="p-4 rounded-xl border border-[#E5E5E5] bg-[#0F0F14] text-white space-y-2">
                <span className="text-xs font-mono text-[#2DD4BF]">Xero Accounting (Bill LineItems)</span>
                <pre className="text-[11px] font-mono text-gray-300 overflow-x-auto p-3 rounded-lg bg-black/40">
                  {JSON.stringify(ACCOUNTING_SANDBOX_MAPPINGS.xero.example, null, 2)}
                </pre>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
