"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  SplitSquareVertical,
  QrCode,
  Shield,
  Zap,
  Receipt,
  BarChart3,
  Globe,
  Wallet,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const features = [
  {
    icon: SplitSquareVertical,
    title: "Flexible Bill Splitting",
    description:
      "Choose a 50/50 split or assign custom shares per person. Handle groups of any size with 7-decimal XLM accuracy.",
    tag: "Core",
    accent: false,
  },
  {
    icon: Zap,
    title: "Real-Time Stellar Transfers",
    description:
      "Settle directly on Stellar with around 5-second finality. No middlemen, no delays, just fast blockchain-native movement of funds.",
    tag: "P0",
    accent: true,
  },
  {
    icon: QrCode,
    title: "Scan-to-Pay QR",
    description:
      "Create SEP-0007 QR codes for every payment so Stellar-compatible wallets can scan and prefill transaction data instantly.",
    tag: "USP",
    accent: false,
  },
  {
    icon: Receipt,
    title: "Ledger-Backed Receipts",
    description:
      "Each payment carries a memo stored permanently on the Stellar ledger, giving you a transparent and tamper-proof receipt trail.",
    tag: "USP",
    accent: false,
  },
  {
    icon: BarChart3,
    title: "Smart Settle-Up",
    description:
      "Use net-balance optimization to cut unnecessary transfers. Multiple individual paybacks can be compressed into one clean payment.",
    tag: "Smart",
    accent: false,
  },
  {
    icon: Globe,
    title: "Trip Expense Groups",
    description:
      "Bundle shared costs into a single trip, invite members, track spending in one place, and settle everything at the end.",
    tag: "P2",
    accent: false,
  },
  {
    icon: Shield,
    title: "Self-Custody by Design",
    description:
      "Your keys stay in your wallet at all times. With Freighter integration, Stellar-star never takes custody of your funds.",
    tag: "Security",
    accent: false,
  },
  {
    icon: Wallet,
    title: "One-Click Freighter Connect",
    description:
      "Connect instantly through the Freighter extension with support for both Stellar testnet and mainnet environments.",
    tag: "Wallet",
    accent: false,
  },
];

const containerVariants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.07 },
  },
};

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, ease: [0.22, 1, 0.36, 1] },
  },
};

export default function Features() {
  return (
    <section id="features" className="section-padding bg-[#F6F6F6] relative overflow-hidden">
      {/* Subtle radial */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 40% at 50% 100%, rgba(185,255,102,0.08), transparent)",
        }}
      />

      <div className="container-max relative">
        {/* Section header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, margin: "-80px" }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-16 max-w-2xl mx-auto"
        >
          <Badge variant="lime" className="mb-4">
            <Zap size={11} className="fill-current" />
            Everything you need
          </Badge>
          <h2 className="heading-section text-[#0F0F14] mb-4">
            Built for real group expenses,
            <br />
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage: "linear-gradient(135deg, #2DD4BF, #0D9488)",
              }}
            >
              settled on-chain.
            </span>
          </h2>
          <p className="text-[#666] text-lg leading-relaxed">
            Every feature designed around the actual pain of splitting bills — with
            the transparency and security of Stellar blockchain.
          </p>
        </motion.div>

        {/* Feature Grid */}
        <motion.div
          variants={containerVariants}
          initial="hidden"
          whileInView="visible"
          viewport={{ once: true, margin: "-60px" }}
          className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4"
        >
          {features.map((feature, i) => {
            const Icon = feature.icon;
            return (
              <motion.div
                key={feature.title}
                variants={cardVariants}
                className={`group relative p-6 rounded-3xl border transition-all duration-300 cursor-default ${
                  feature.accent
                    ? "bg-[#2DD4BF] border-[#2DD4BF] hover:shadow-[0_8px_40px_-8px_rgba(185,255,102,0.45)]"
                    : "bg-white border-[#E5E5E5] hover:border-[#2DD4BF]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.12)]"
                }`}
              >
                {/* Icon */}
                <div
                  className={`w-10 h-10 rounded-xl flex items-center justify-center mb-4 ${
                    feature.accent
                      ? "bg-[#0F0F14] text-[#2DD4BF]"
                      : "bg-[#F6F6F6] text-[#0F0F14] group-hover:bg-[#2DD4BF]/15 group-hover:text-[#134E4A]"
                  } transition-all duration-200`}
                >
                  <Icon size={18} />
                </div>

                {/* Tag */}
                <div className="mb-3">
                  <span
                    className={`text-[10px] font-bold uppercase tracking-widest ${
                      feature.accent ? "text-[#134E4A]" : "text-[#AAA]"
                    }`}
                  >
                    {feature.tag}
                  </span>
                </div>

                {/* Content */}
                <h3
                  className={`text-[17px] font-bold mb-2 leading-snug ${
                    feature.accent ? "text-[#0F0F14]" : "text-[#0F0F14]"
                  }`}
                >
                  {feature.title}
                </h3>
                <p
                  className={`text-sm leading-relaxed ${
                    feature.accent ? "text-[#0F0F14]/70" : "text-[#666]"
                  }`}
                >
                  {feature.description}
                </p>
              </motion.div>
            );
          })}
        </motion.div>
      </div>
    </section>
  );
}
