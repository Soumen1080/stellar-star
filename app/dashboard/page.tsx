"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Zap,
  ArrowLeft,
  Shield,
  Clock,
  Layers,
  ArrowRight,
  ReceiptText,
  QrCode,
  Plus,
  Map,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
} from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { useAuth } from "@/context/AuthContext";
import { useExpense } from "@/hooks/useExpense";
import { useTrip } from "@/hooks/useTrip";
import { AuthGuard } from "@/components/auth/AuthGuard";
import { ConnectWalletButton } from "@/components/wallet/ConnectWalletButton";
import { WalletInfo } from "@/components/wallet/WalletInfo";
import { Spinner } from "@/components/ui/Spinner";
import { formatAddress } from "@/lib/utils";
import type { Expense } from "@/types/expense";

// ─── Not-connected view ───────────────────────────────────────────────────────

function ConnectPrompt() {
  return (
    <div className="min-h-screen bg-[#F6F6F6] flex flex-col">
      {/* Minimal header */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-[#E5E5E5] bg-white">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#2DD4BF] flex items-center justify-center">
            <Zap size={15} className="text-[#0F0F14] fill-[#0F0F14]" />
          </div>
          <span className="text-lg font-black tracking-tight text-[#0F0F14]">
            Stellar<span className="text-[#2DD4BF]">-star</span>
          </span>
        </Link>
        <Link
          href="/"
          className="flex items-center gap-1.5 text-sm font-medium text-[#555] hover:text-[#0F0F14] transition-colors"
        >
          <ArrowLeft size={14} />
          Back to Home
        </Link>
      </nav>

      {/* Connect card */}
      <div className="flex-1 flex items-center justify-center px-4 py-12">
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-md"
        >
          <div className="bg-white rounded-3xl border border-[#E5E5E5] shadow-[0_4px_40px_-8px_rgba(0,0,0,0.08)] overflow-hidden">
            <div className="h-1 w-full bg-gradient-to-r from-transparent via-[#2DD4BF] to-transparent" />
            <div className="p-8">
              <div className="w-14 h-14 rounded-2xl bg-[#2DD4BF] flex items-center justify-center mb-6 shadow-[0_4px_20px_-4px_rgba(185,255,102,0.5)]">
                <Zap size={24} className="text-[#0F0F14] fill-[#0F0F14]" />
              </div>
              <h1 className="text-2xl font-black text-[#0F0F14] mb-2">
                Connect your wallet
              </h1>
              <p className="text-[#666] text-sm leading-relaxed mb-8">
                Stellar-star uses the{" "}
                <a href="https://freighter.app" target="_blank" rel="noopener noreferrer"
                  className="font-semibold text-[#0F0F14] underline underline-offset-2">
                  Freighter
                </a>{" "}
                browser wallet to sign Stellar transactions. No account or password needed — just your keys.
              </p>
              <ConnectWalletButton className="w-full justify-center py-3 text-base rounded-2xl" />
              <div className="grid grid-cols-3 gap-3 mt-6 pt-6 border-t border-[#E5E5E5]">
                {[
                  { icon: Shield, label: "Non-custodial" },
                  { icon: Clock, label: "<5s finality" },
                  { icon: Layers, label: "On-chain receipts" },
                ].map(({ icon: I, label }) => (
                  <div key={label} className="text-center">
                    <I size={14} className="text-[#2DD4BF] mx-auto mb-1" />
                    <p className="text-[10px] font-medium text-[#888]">{label}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
          <p className="text-center text-xs text-[#AAA] mt-4">
            Don&apos;t have Freighter?{" "}
            <a href="https://freighter.app" target="_blank" rel="noopener noreferrer"
              className="font-semibold text-[#555] hover:text-[#0F0F14] underline">
              Install it free →
            </a>
          </p>
        </motion.div>
      </div>
    </div>
  );
}

// ─── Stat card ────────────────────────────────────────────────────────────────

function StatCard({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ElementType;
  accent?: boolean;
}) {
  return (
    <div className={`rounded-2xl border p-4 ${accent ? "bg-[#0F0F14] border-transparent" : "bg-white border-[#E5E5E5]"}`}>
      <Icon size={14} className={accent ? "text-[#2DD4BF] mb-2" : "text-[#AAA] mb-2"} />
      <p className={`text-xl font-black ${accent ? "text-[#2DD4BF]" : "text-[#0F0F14]"}`}>{value}</p>
      <p className={`text-xs font-semibold mt-0.5 ${accent ? "text-[#666]" : "text-[#888]"}`}>{label}</p>
      {sub && <p className={`text-[10px] mt-0.5 ${accent ? "text-[#555]" : "text-[#AAA]"}`}>{sub}</p>}
    </div>
  );
}

// ─── Recent expense row ───────────────────────────────────────────────────────

function RecentExpenseRow({ expense }: { expense: Expense }) {
  const paidCount = expense.shares.filter((s) => s.paid).length;
  const total = parseFloat(expense.totalAmount);
  const allPaid = paidCount === expense.shares.length && expense.shares.length > 0;
  const date = new Date(expense.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });

  return (
    <Link
      href="/expenses"
      className="flex items-center gap-3 p-3 rounded-xl hover:bg-[#F6F6F6] transition-colors group"
    >
      <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${allPaid ? "bg-[#2DD4BF]/20" : "bg-[#0F0F14]"}`}>
        <ReceiptText size={13} className={allPaid ? "text-[#134E4A]" : "text-[#2DD4BF]"} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#0F0F14] truncate">{expense.title}</p>
        <p className="text-[11px] text-[#AAA]">
          {total.toFixed(4)} XLM · {expense.members.length} members · {date}
        </p>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {allPaid ? (
          <CheckCircle2 size={14} className="text-[#134E4A]" />
        ) : (
          <span className="text-[11px] font-semibold text-[#888]">
            {paidCount}/{expense.shares.length}
          </span>
        )}
        <ArrowRight size={12} className="text-[#D0D0D0] group-hover:text-[#888] transition-colors" />
      </div>
    </Link>
  );
}

// ─── Connected dashboard view ─────────────────────────────────────────────────

function DashboardView() {
  const { publicKey } = useWallet();
  const { user } = useAuth();
  const { expenses } = useExpense();
  const { trips } = useTrip();

  const recentExpenses = expenses.slice(0, 5);
  const totalXLM = expenses.reduce((s, e) => s + parseFloat(e.totalAmount), 0);
  const pendingShares = expenses
    .flatMap((e) => e.shares)
    .filter((s) => !s.paid).length;
  const settledExpenses = expenses.filter((e) => e.settled).length;

  const appFeatures = [
    { icon: ReceiptText, title: "Expenses", desc: "Add bills & split them instantly.", href: "/expenses", badge: `${expenses.length}` },
    { icon: Zap, title: "Pay via XLM", desc: "Sign payments with Freighter.", href: "/expenses", badge: "Live" },
    { icon: QrCode, title: "QR Payments", desc: "SEP-0007 QR codes for any Stellar wallet.", href: "/expenses", badge: "Live" },
    { icon: Map, title: "Trip Mode", desc: "Group expenses & settle as a team.", href: "/trips", badge: `${trips.length}` },
  ];

  return (
    <div className="min-h-screen bg-[#F6F6F6]">
      {/* Nav */}
      <nav className="sticky top-0 z-40 flex items-center justify-between px-4 sm:px-6 py-3 border-b border-[#E5E5E5] bg-white/90 backdrop-blur-xl">
        <Link href="/" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-xl bg-[#2DD4BF] flex items-center justify-center">
            <Zap size={15} className="text-[#0F0F14] fill-[#0F0F14]" />
          </div>
          <span className="text-lg font-black tracking-tight text-[#0F0F14]">
            Stellar<span className="text-[#2DD4BF]">-star</span>
          </span>
        </Link>
        <div className="hidden sm:flex items-center gap-1">
          <Link href="/expenses" className="px-3 py-1.5 text-sm font-medium text-[#555] hover:text-[#0F0F14] rounded-xl hover:bg-black/5 transition-all">
            Expenses
          </Link>
          <Link href="/trips" className="px-3 py-1.5 text-sm font-medium text-[#555] hover:text-[#0F0F14] rounded-xl hover:bg-black/5 transition-all">
            Trips
          </Link>
        </div>
        <ConnectWalletButton />
      </nav>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-6 sm:py-8">

        {/* ── Welcome banner ── */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45 }}
          className="bg-[#0F0F14] rounded-3xl p-5 sm:p-8 mb-6 relative overflow-hidden"
        >
          <div className="absolute inset-0 rounded-3xl pointer-events-none"
            style={{ background: "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(185,255,102,0.1), transparent)" }} />
          <div className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-1/2 pointer-events-none"
            style={{ background: "linear-gradient(90deg, transparent, #2DD4BF, transparent)" }} />
          <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div>
              <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#2DD4BF]/10 border border-[#2DD4BF]/20 rounded-full text-xs font-semibold text-[#2DD4BF] mb-3">
                <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] animate-pulse" />
                Wallet Connected · Stellar Testnet
              </div>
              <h2 className="text-xl sm:text-2xl font-black text-white mb-1">
                Welcome,{" "}
                <span className="text-[#2DD4BF]">
                  {user?.displayName || (publicKey ? formatAddress(publicKey, 5) : "…")}
                </span>
              </h2>
              <p className="text-[#666] text-sm">
                Split expenses, pay with XLM, and track settlements on-chain.
              </p>
            </div>
          </div>
        </motion.div>

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          <StatCard icon={ReceiptText} label="Total Expenses" value={expenses.length} sub={`${settledExpenses} settled`} />
          <StatCard icon={TrendingUp} label="Total XLM Spent" value={`${totalXLM.toFixed(2)}`} sub="across all bills" accent />
          <StatCard icon={AlertCircle} label="Pending Shares" value={pendingShares} sub="awaiting payment" />
          <StatCard icon={Map} label="Trips" value={trips.length} sub={`${trips.filter(t => t.settled).length} settled`} />
        </div>

        {/* ── Main grid: wallet info + recent expenses ── */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">

          {/* Wallet panel */}
          <div className="lg:col-span-1">
            <WalletInfo />
          </div>

          {/* Recent expenses */}
          <div className="lg:col-span-2 bg-white rounded-2xl border border-[#E5E5E5] overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b border-[#F5F5F5]">
              <div className="flex items-center gap-2">
                <ReceiptText size={14} className="text-[#2DD4BF]" />
                <p className="text-sm font-bold text-[#0F0F14]">Recent Expenses</p>
              </div>
              <Link
                href="/expenses"
                className="text-xs font-semibold text-[#555] hover:text-[#0F0F14] transition-colors"
              >
                View all →
              </Link>
            </div>

            {recentExpenses.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-10 px-4 text-center">
                <div className="w-12 h-12 rounded-2xl bg-[#F0F0F0] flex items-center justify-center mb-3">
                  <ReceiptText size={18} className="text-[#CCC]" />
                </div>
                <p className="text-sm font-semibold text-[#555] mb-1">No expenses yet</p>
                <p className="text-xs text-[#AAA] mb-4">Create your first expense to get started</p>
                <Link
                  href="/expenses"
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-xs font-bold hover:bg-[#1A1A22] transition-all"
                >
                  <Plus size={12} />
                  New Expense
                </Link>
              </div>
            ) : (
              <div className="p-2">
                {recentExpenses.map((expense) => (
                  <RecentExpenseRow key={expense.id} expense={expense} />
                ))}
                {expenses.length > 5 && (
                  <Link
                    href="/expenses"
                    className="flex items-center justify-center gap-1.5 py-2.5 mt-1 rounded-xl text-xs font-semibold text-[#888] hover:text-[#0F0F14] hover:bg-[#F6F6F6] transition-colors"
                  >
                    +{expenses.length - 5} more expenses
                    <ArrowRight size={11} />
                  </Link>
                )}
              </div>
            )}
          </div>
        </div>

        {/* ── App feature cards ── */}
        <p className="text-xs font-semibold uppercase tracking-wider text-[#AAA] mb-3">Quick Access</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
          {appFeatures.map((f) => (
            <Link
              key={f.title}
              href={f.href}
              className="bg-white rounded-2xl border border-[#E5E5E5] p-4 hover:border-[#2DD4BF]/50 hover:shadow-[0_4px_20px_-4px_rgba(185,255,102,0.15)] transition-all group"
            >
              <div className="flex items-start justify-between mb-3">
                <div className="w-9 h-9 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center">
                  <f.icon size={15} className="text-[#134E4A]" />
                </div>
                <span className="text-[10px] font-bold text-[#134E4A] bg-[#2DD4BF]/20 px-2 py-0.5 rounded-full">
                  {f.badge}
                </span>
              </div>
              <p className="text-sm font-bold text-[#0F0F14] mb-0.5">{f.title}</p>
              <p className="text-[11px] text-[#888] leading-relaxed">{f.desc}</p>
              <div className="flex items-center gap-1 mt-3 text-[11px] font-semibold text-[#134E4A] group-hover:gap-2 transition-all">
                Open <ArrowRight size={10} />
              </div>
            </Link>
          ))}
        </div>

        {/* ── CTA row ── */}
        <div className="flex flex-wrap items-center gap-3">
          <Link
            href="/expenses"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
          >
            <Plus size={14} />
            New Expense
          </Link>
          <Link
            href="/trips"
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[#E5E5E5] text-[#555] text-sm font-bold hover:bg-[#F0F0F0] transition-all"
          >
            <Map size={14} />
            View Trips
          </Link>
        </div>
      </main>
    </div>
  );
}

// ─── Page root ────────────────────────────────────────────────────────────────

export default function DashboardPage() {
  const { isConnected, isConnecting } = useWallet();

  if (isConnecting) {
    return (
      <div className="min-h-screen bg-[#F6F6F6] flex items-center justify-center">
        <Spinner size={32} className="text-[#2DD4BF]" />
      </div>
    );
  }

  if (!isConnected) {
    return <ConnectPrompt />;
  }

  return (
    <AuthGuard>
      <DashboardView />
    </AuthGuard>
  );
}
