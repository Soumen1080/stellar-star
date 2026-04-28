"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  ArrowRight,
  Zap,
  Shield,
  Globe,
  CheckCircle2,
  TrendingUp,
  Users,
  Star,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { useAuth } from "@/context/AuthContext";

/* ── animation variants ── */
const fadeUp = {
  hidden: { opacity: 0, y: 40 },
  visible: (i = 0) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.6, delay: i * 0.1, ease: [0.22, 1, 0.36, 1] },
  }),
};

const stagger = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.08 } },
};

/* ── Mock UI Card ── */
const MockSplitCard = () => (
  <div className="bg-white rounded-3xl border border-[#E5E5E5] shadow-[0_8px_60px_-12px_rgba(0,0,0,0.18)] overflow-hidden w-full max-w-sm">
    {/* Card Header */}
    <div className="p-5 border-b border-[#F0F0F0]">
      <div className="flex items-center justify-between mb-1">
        <p className="text-xs font-medium text-[#888]">Group Dinner · tonight</p>
        <span className="bg-[#2DD4BF]/20 text-[#134E4A] text-xs font-semibold px-2 py-0.5 rounded-full">Active</span>
      </div>
      <p className="text-2xl font-black tracking-tight">1,200 XLM</p>
      <p className="text-xs text-[#aaa] mt-0.5">Split 4 ways · Equal</p>
    </div>

    {/* Members */}
    <div className="p-4 space-y-2.5">
      {[
        { name: "Rahul", amount: "300", status: "paid", color: "#2DD4BF" },
        { name: "Aman", amount: "300", status: "pending", color: "#E5E5E5" },
        { name: "Kiran", amount: "300", status: "pending", color: "#E5E5E5" },
        { name: "You", amount: "300", status: "paid", color: "#2DD4BF" },
      ].map((member) => (
        <div key={member.name} className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold"
              style={{
                backgroundColor: member.status === "paid" ? "#2DD4BF" : "#F6F6F6",
                color: member.status === "paid" ? "#0F0F14" : "#888",
              }}
            >
              {member.name[0]}
            </div>
            <span className="text-sm font-medium text-[#0F0F14]">{member.name}</span>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{member.amount} XLM</span>
            {member.status === "paid" ? (
              <CheckCircle2 size={14} className="text-[#134E4A] fill-[#2DD4BF]" />
            ) : (
              <div className="w-3.5 h-3.5 rounded-full border-2 border-[#D0D0D0]" />
            )}
          </div>
        </div>
      ))}
    </div>

    {/* CTA in card */}
    <div className="px-4 pb-4">
      <div className="w-full py-2.5 bg-[#0F0F14] text-white text-sm font-semibold rounded-xl flex items-center justify-center gap-2">
        <Zap size={14} className="fill-[#2DD4BF] text-[#2DD4BF]" />
        Settle via Stellar
      </div>
    </div>
  </div>
);

/* ── Floating stat chips ── */
const FloatingChip = ({
  icon: Icon,
  label,
  value,
  className,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  className?: string;
}) => (
  <motion.div
    animate={{ y: [0, -6, 0] }}
    transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
    className={`bg-white rounded-2xl border border-[#E5E5E5] shadow-[0_4px_24px_-6px_rgba(0,0,0,0.12)] px-4 py-3 flex items-center gap-3 ${className}`}
  >
    <div className="w-8 h-8 rounded-xl bg-[#2DD4BF]/15 flex items-center justify-center">
      <Icon size={15} className="text-[#134E4A]" />
    </div>
    <div>
      <p className="text-xs text-[#888] leading-none mb-0.5">{label}</p>
      <p className="text-sm font-bold text-[#0F0F14] leading-none">{value}</p>
    </div>
  </motion.div>
);

/* ── Trust logos ── */
const trustLogos = [
  { name: "Stellar", abbr: "STL" },
  { name: "Freighter", abbr: "FRT" },
  { name: "Horizon", abbr: "HRZ" },
  { name: "Testnet", abbr: "TST" },
  { name: "XLM", abbr: "XLM" },
];

export default function Hero() {
  const { isAuthenticated } = useAuth();

  return (
    <section className="relative min-h-screen overflow-hidden bg-[#F6F6F6]">
      {/* Background radial + grid */}
      <div className="absolute inset-0 bg-hero-grid bg-[length:40px_40px] opacity-100" />
      <div
        className="absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 80% 55% at 50% -5%, rgba(185,255,102,0.18), transparent 70%)",
        }}
      />

      {/* Blobs */}
      <div className="pointer-events-none absolute -top-40 -left-40 w-[600px] h-[600px] bg-[#2DD4BF]/10 rounded-full blur-[120px]" />
      <div className="pointer-events-none absolute -bottom-20 -right-40 w-[500px] h-[500px] bg-[#2DD4BF]/08 rounded-full blur-[100px]" />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-20 pb-16 sm:pt-24 lg:pt-28 lg:pb-24">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-8 items-center">
          {/* ── LEFT: Copy ── */}
          <motion.div
            variants={stagger}
            initial={false}
            animate="visible"
            className="max-w-2xl"
          >
            {/* Badge pill */}
            <motion.div variants={fadeUp} custom={0}>
              <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#2DD4BF]/15 border border-[#2DD4BF]/30 rounded-full text-xs font-semibold text-[#134E4A] mb-6">
                <span className="w-1.5 h-1.5 rounded-full bg-[#134E4A] animate-pulse" />
                Powered by Stellar Blockchain
              </div>
            </motion.div>

            {/* Headline */}
            <motion.h1
              variants={fadeUp}
              custom={1}
              className="text-[1.9rem] xs:text-[2.2rem] sm:text-[3.4rem] lg:text-[4rem] xl:text-[4.6rem] font-black leading-[1.1] tracking-tight text-[#0F0F14] mb-6"
            >
              Share Expenses.
              <br />
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #2DD4BF 0%, #0D9488 100%)",
                }}
              >
                Settle Instantly.
              </span>
            </motion.h1>

            {/* Sub */}
            <motion.p
              variants={fadeUp}
              custom={2}
              className="text-lg text-[#666] leading-relaxed mb-8 max-w-lg"
            >
              Track shared spending and settle with your group directly on the{" "}
              <span className="font-semibold text-[#0F0F14]">
                Stellar Network
              </span>{" "}
              — fast, transparent, and verifiable.
            </motion.p>

            {/* CTA row */}
            <motion.div
              variants={fadeUp}
              custom={3}
              className="flex flex-col sm:flex-row gap-3 mb-10"
            >
              <Button variant="primary" size="lg" asChild>
                <Link href={isAuthenticated ? "/dashboard" : "/auth"}>
                  {isAuthenticated ? "Open Dashboard" : "Start Splitting"}
                  <ArrowRight size={18} />
                </Link>
              </Button>
              <Button variant="secondary" size="lg" asChild>
                <Link href="#how-it-works">Explore the Flow</Link>
              </Button>
            </motion.div>

            {/* Social proof row */}
            <motion.div
              variants={fadeUp}
              custom={4}
              className="flex flex-col sm:flex-row sm:items-center gap-4"
            >
              {/* Avatars */}
              <div className="flex items-center gap-2">
                <div className="flex -space-x-2">
                  {["R", "A", "K", "S"].map((l, i) => (
                    <div
                      key={i}
                      className="w-8 h-8 rounded-full border-2 border-white flex items-center justify-center text-xs font-bold text-white"
                      style={{
                        backgroundColor: [
                          "#2DD4BF",
                          "#0F0F14",
                          "#0D9488",
                          "#333",
                        ][i],
                        color: i === 0 || i === 2 ? "#0F0F14" : "white",
                      }}
                    >
                      {l}
                    </div>
                  ))}
                  <div className="w-8 h-8 rounded-full border-2 border-white bg-[#F0F0F0] flex items-center justify-center text-[10px] font-semibold text-[#888]">
                    +2K
                  </div>
                </div>
                <div>
                  <div className="flex items-center gap-0.5">
                    {[...Array(5)].map((_, i) => (
                      <Star
                        key={i}
                        size={12}
                        className="text-[#2DD4BF] fill-[#2DD4BF]"
                      />
                    ))}
                  </div>
                  <p className="text-xs text-[#888]">2,000+ early users</p>
                </div>
              </div>

              <div className="hidden sm:block w-px h-8 bg-[#E5E5E5]" />

              {/* Proof labels */}
              {[
                { icon: Shield, text: "Non-custodial" },
                { icon: Zap, text: "~5s finality" },
              ].map(({ icon: Icon, text }) => (
                <div key={text} className="flex items-center gap-1.5">
                  <Icon size={14} className="text-[#134E4A]" />
                  <span className="text-sm font-medium text-[#555]">{text}</span>
                </div>
              ))}
            </motion.div>
          </motion.div>

          {/* ── RIGHT: Visual ── */}
          <motion.div
            initial={false}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            className="relative flex justify-center lg:justify-end"
          >
            {/* Glow behind card */}
            <div className="absolute inset-0 bg-[#2DD4BF]/20 rounded-full blur-[80px] scale-75" />

            <div className="relative">
              {/* Main mock card */}
              <MockSplitCard />

              {/* Floating chips */}
              <FloatingChip
                icon={TrendingUp}
                label="Total Settled"
                value="2.3M XLM"
                className="hidden lg:flex absolute -top-4 -left-14 w-44"
              />
              <FloatingChip
                icon={Users}
                label="Active Groups"
                value="8,200+"
                className="hidden lg:flex absolute -bottom-4 -right-10 w-40"
              />

              {/* TX hash strip */}
              <motion.div
                animate={{ y: [0, -4, 0] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                className="hidden lg:flex absolute -bottom-12 left-0 right-0 mx-4 bg-[#0F0F14] text-white rounded-2xl px-4 py-3 items-center gap-3"
              >
                <CheckCircle2 size={16} className="text-[#2DD4BF] fill-[#2DD4BF] shrink-0" />
                <div className="overflow-hidden">
                  <p className="text-[10px] text-[#888] mb-0.5">TX Confirmed · Ledger 47,291,034</p>
                  <p className="text-xs font-mono text-[#2DD4BF] truncate">
                    0xabc1…f324 · 300 XLM to Aman
                  </p>
                </div>
              </motion.div>
            </div>
          </motion.div>
        </div>

        {/* ── Trust strip ── */}
        <motion.div
          initial={false}
          animate={{ opacity: 1, y: 0 }}
          className="mt-12 lg:mt-28 pt-8 border-t border-[#E5E5E5]"
        >
          <p className="text-xs font-semibold uppercase tracking-widest text-[#AAA] text-center mb-6">
            Built on open, trusted protocols
          </p>
          <div className="flex items-center justify-center flex-wrap gap-4 sm:gap-8">
            {trustLogos.map((logo) => (
              <div
                key={logo.name}
                className="flex items-center gap-2 text-[#888] hover:text-[#0F0F14] transition-colors cursor-default"
              >
                <div className="w-6 h-6 rounded-md bg-[#0F0F14] flex items-center justify-center">
                  <span className="text-[8px] font-black text-[#2DD4BF]">{logo.abbr}</span>
                </div>
                <span className="text-sm font-semibold">{logo.name}</span>
              </div>
            ))}
          </div>
        </motion.div>
      </div>
    </section>
  );
}
