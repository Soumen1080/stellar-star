"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import {
  Shield,
  Zap,
  Globe,
  Lock,
  ArrowRight,
  ExternalLink,
  CheckCircle2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const highlights = [
  {
    icon: Shield,
    title: "100% Non-Custodial",
    description:
      "Your private keys never touch our servers. All signing happens inside Freighter on your device.",
  },
  {
    icon: Zap,
    title: "Stellar-Native Speed",
    description:
      "5-second transaction finality. The Stellar consensus protocol settles payments faster than traditional finance.",
  },
  {
    icon: Globe,
    title: "Borderless Payments",
    description:
      "Anyone with a Freighter wallet and XLM can participate — no bank account, no geography limits.",
  },
  {
    icon: Lock,
    title: "Immutable Receipts",
    description:
      "Every payment memo is permanently on-chain. No one can delete or alter the record of who paid whom.",
  },
];

/* ── Mock Explorer Card ── */
const MockExplorer = () => (
  <div className="bg-[#1A1A22] rounded-2xl border border-white/5 overflow-hidden">
    {/* Header */}
    <div className="flex items-center justify-between px-5 py-3 border-b border-white/5">
      <div className="flex items-center gap-2">
        <div className="w-2 h-2 rounded-full bg-[#2DD4BF] animate-pulse" />
        <span className="text-xs font-mono text-[#888]">stellar.expert/explorer/testnet</span>
      </div>
      <ExternalLink size={12} className="text-[#555]" />
    </div>

    <div className="p-5 space-y-4">
      {/* TX Title */}
      <div>
        <p className="text-[10px] uppercase tracking-widest text-[#555] mb-1">Transaction</p>
        <p className="text-sm font-mono text-[#2DD4BF] break-all">
          4f3a892c...8e2f1d20
        </p>
      </div>

      {/* Fields */}
      {[
        { label: "Status", value: "✓ Success", color: "#2DD4BF" },
        { label: "Ledger", value: "47,291,034" },
        { label: "Amount", value: "300.0000000 XLM" },
        { label: "Memo", value: "SettleX|Dinner|Aman" },
        { label: "Fee", value: "0.00001 XLM" },
      ].map(({ label, value, color }) => (
        <div key={label} className="flex items-center justify-between text-xs border-t border-white/5 pt-3">
          <span className="text-[#555] font-medium">{label}</span>
          <span
            className="font-mono font-semibold"
            style={{ color: color || "#aaa" }}
          >
            {value}
          </span>
        </div>
      ))}
    </div>
  </div>
);

export default function DarkSection() {
  return (
    <section className="relative bg-[#0F0F14] overflow-hidden">
      {/* Grid overlay */}
      <div className="absolute inset-0 bg-grid-dark opacity-60 pointer-events-none" />

      {/* Lime radial glow top */}
      <div
        className="pointer-events-none absolute -top-40 left-1/2 -translate-x-1/2 w-[800px] h-[400px] rounded-full blur-[120px]"
        style={{ background: "rgba(185,255,102,0.06)" }}
      />

      {/* Lime radial glow bottom */}
      <div
        className="pointer-events-none absolute -bottom-40 right-0 w-[500px] h-[500px] rounded-full blur-[100px]"
        style={{ background: "rgba(185,255,102,0.04)" }}
      />

      <div className="relative max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-24 lg:py-32">
        {/* Section label */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5 }}
          className="flex justify-center mb-16"
        >
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#2DD4BF]/10 border border-[#2DD4BF]/20 rounded-full text-xs font-semibold text-[#2DD4BF]">
            <Shield size={11} />
            Built on trust, verified on-chain
          </div>
        </motion.div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 lg:gap-16 items-center">
          {/* ── LEFT: Copy + highlights ── */}
          <div className="lg:col-span-7">
            <motion.h2
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
              className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.05] tracking-tight text-white mb-6"
            >
              Transparency isn&apos;t a feature.
              <br />
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage: "linear-gradient(135deg, #2DD4BF 0%, #14B8A6 100%)",
                }}
              >
                It&apos;s the foundation.
              </span>
            </motion.h2>

            <motion.p
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.1 }}
              className="text-[#888] text-lg leading-relaxed mb-10 max-w-xl"
            >
              Every transaction on SettleX is permanently recorded on the Stellar
              ledger. No central server. No hidden fees. No trust required — just
              math and cryptography.
            </motion.p>

            {/* Highlights grid */}
            <motion.div
              initial={{ opacity: 0 }}
              whileInView={{ opacity: 1 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.2 }}
              className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-10"
            >
              {highlights.map((h, i) => {
                const Icon = h.icon;
                return (
                  <motion.div
                    key={h.title}
                    initial={{ opacity: 0, y: 20 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ duration: 0.5, delay: 0.1 + i * 0.07 }}
                    className="group p-5 rounded-2xl bg-white/5 border border-white/5 hover:border-[#2DD4BF]/20 hover:bg-white/8 transition-all duration-300"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <div className="w-8 h-8 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center group-hover:bg-[#2DD4BF]/20 transition-all">
                        <Icon size={15} className="text-[#2DD4BF]" />
                      </div>
                      <h3 className="text-sm font-bold text-white">{h.title}</h3>
                    </div>
                    <p className="text-xs text-[#666] leading-relaxed pl-11">
                      {h.description}
                    </p>
                  </motion.div>
                );
              })}
            </motion.div>

            {/* CTA */}
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5, delay: 0.3 }}
              className="flex flex-col sm:flex-row gap-3"
            >
              <Button variant="primary" size="lg" asChild>
                <Link href="/dashboard">
                  Get Started Free
                  <ArrowRight size={18} />
                </Link>
              </Button>
              <Button variant="outline-lime" size="lg" asChild>
                <a
                  href="https://stellar.expert/explorer/testnet"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  View on Stellar Explorer
                  <ExternalLink size={16} />
                </a>
              </Button>
            </motion.div>
          </div>

          {/* ── RIGHT: Mock explorer ── */}
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7, delay: 0.15, ease: [0.22, 1, 0.36, 1] }}
            className="lg:col-span-5 space-y-4"
          >
            <MockExplorer />

            {/* Verification strip */}
            <div className="flex items-center gap-3 bg-[#2DD4BF]/8 border border-[#2DD4BF]/15 rounded-2xl px-4 py-3">
              <CheckCircle2 size={18} className="text-[#2DD4BF] shrink-0" />
              <div>
                <p className="text-xs font-semibold text-white">
                  Publicly verifiable
                </p>
                <p className="text-[11px] text-[#666]">
                  Anyone with the TX hash can verify this payment independently
                </p>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
