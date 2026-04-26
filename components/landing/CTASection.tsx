"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Zap, Shield, Star } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useAuth } from "@/context/AuthContext";

const perks = [
  { icon: Zap, text: "No account required" },
  { icon: Shield, text: "Non-custodial" },
  { icon: Star, text: "Free forever (testnet)" },
];

export default function CTASection() {
  const { isAuthenticated } = useAuth();

  return (
    <section className="relative bg-[#F6F6F6] overflow-hidden">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20 lg:py-28">
        <motion.div
          initial={{ opacity: 0, y: 40, scale: 0.97 }}
          whileInView={{ opacity: 1, y: 0, scale: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
          className="relative bg-[#0F0F14] rounded-[2rem] overflow-hidden"
        >
          {/* Grid */}
          <div className="absolute inset-0 bg-grid-dark opacity-60 pointer-events-none" />

          {/* Top lime glow */}
          <div
            className="pointer-events-none absolute -top-20 left-1/2 -translate-x-1/2 w-[500px] h-[300px] rounded-full blur-[80px]"
            style={{ background: "rgba(185,255,102,0.12)" }}
          />

          {/* Bottom right glow */}
          <div
            className="pointer-events-none absolute bottom-0 right-0 w-[400px] h-[300px] rounded-full blur-[100px]"
            style={{ background: "rgba(185,255,102,0.05)" }}
          />

          {/* Lime accent bar top */}
          <div
            className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-3/4"
            style={{
              background:
                "linear-gradient(90deg, transparent, #2DD4BF, transparent)",
            }}
          />

          <div className="relative text-center px-6 py-16 lg:py-20">
            {/* Badge */}
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#2DD4BF]/10 border border-[#2DD4BF]/20 rounded-full text-xs font-semibold text-[#2DD4BF] mb-8">
              <Zap size={11} className="fill-[#2DD4BF]" />
              Ready when you are · Stellar Testnet
            </div>

            {/* Headline */}
            <h2 className="text-4xl sm:text-5xl lg:text-6xl font-black leading-[1.05] tracking-tight text-white mb-6 max-w-3xl mx-auto">
              Stop chasing friends
              <br />
              for{" "}
              <span
                className="bg-clip-text text-transparent"
                style={{
                  backgroundImage:
                    "linear-gradient(135deg, #2DD4BF 0%, #14B8A6 100%)",
                }}
              >
                money owed.
              </span>
            </h2>

            {/* Sub */}
            <p className="text-[#888] text-lg leading-relaxed mb-10 max-w-xl mx-auto">
              Connect your Freighter wallet, create an expense, and let Stellar
              settle it in seconds. No middlemen, no drama.
            </p>

            {/* CTA buttons */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-3 mb-10">
              <Button variant="primary" size="xl" asChild>
                <Link href={isAuthenticated ? "/dashboard" : "/auth"}>
                  {isAuthenticated ? "Go to Dashboard" : "Launch SettleX"}
                  <ArrowRight size={20} />
                </Link>
              </Button>
              <Button variant="ghost-white" size="xl" asChild>
                <a
                  href="https://freighter.app"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Get Freighter Wallet
                </a>
              </Button>
            </div>

            {/* Perks row */}
            <div className="flex flex-col sm:flex-row items-center justify-center gap-6">
              {perks.map(({ icon: Icon, text }) => (
                <div
                  key={text}
                  className="flex items-center gap-2 text-sm text-[#666]"
                >
                  <Icon size={14} className="text-[#2DD4BF]" />
                  <span>{text}</span>
                </div>
              ))}
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
