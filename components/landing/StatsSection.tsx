"use client";

import React from "react";
import { motion } from "framer-motion";
import { TrendingUp, Users, Globe, Zap } from "lucide-react";

const stats = [
  {
    icon: TrendingUp,
    value: "2.3M",
    unit: "XLM",
    label: "Total Settled",
    sub: "On Stellar Testnet",
    color: "#2DD4BF",
  },
  {
    icon: Users,
    value: "8,200+",
    unit: "",
    label: "Active Groups",
    sub: "Across 40+ countries",
    color: "#2DD4BF",
  },
  {
    icon: Globe,
    value: "47K+",
    unit: "",
    label: "Transactions",
    sub: "All publicly verifiable",
    color: "#2DD4BF",
  },
  {
    icon: Zap,
    value: "<5s",
    unit: "",
    label: "Average Finality",
    sub: "Stellar consensus speed",
    color: "#2DD4BF",
  },
];

export default function StatsSection() {
  return (
    <section className="relative bg-[#F6F6F6] overflow-hidden">
      {/* Divider lime strip */}
      <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, #2DD4BF, transparent)" }} />

      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-20">
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="grid grid-cols-2 lg:grid-cols-4 gap-6 lg:gap-8"
        >
          {stats.map((stat, i) => {
            const Icon = stat.icon;
            return (
              <motion.div
                key={stat.label}
                initial={{ opacity: 0, y: 20 }}
                whileInView={{ opacity: 1, y: 0 }}
                viewport={{ once: true }}
                transition={{ duration: 0.5, delay: i * 0.08 }}
                className="group relative bg-white rounded-3xl border border-[#E5E5E5] p-6 hover:border-[#2DD4BF]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.1)] transition-all duration-300 cursor-default"
              >
                {/* Icon */}
                <div className="w-10 h-10 rounded-xl bg-[#2DD4BF]/10 flex items-center justify-center mb-4 group-hover:bg-[#2DD4BF]/20 transition-all">
                  <Icon size={18} className="text-[#134E4A]" />
                </div>

                {/* Value */}
                <div className="flex items-baseline gap-1 mb-1">
                  <span className="text-3xl lg:text-4xl font-black text-[#0F0F14] leading-none">
                    {stat.value}
                  </span>
                  {stat.unit && (
                    <span className="text-sm font-bold text-[#2DD4BF]">
                      {stat.unit}
                    </span>
                  )}
                </div>

                {/* Label */}
                <p className="text-sm font-semibold text-[#0F0F14] mb-0.5">
                  {stat.label}
                </p>
                <p className="text-xs text-[#AAA]">{stat.sub}</p>
              </motion.div>
            );
          })}
        </motion.div>
      </div>

      <div className="h-px w-full" style={{ background: "linear-gradient(90deg, transparent, #E5E5E5, transparent)" }} />
    </section>
  );
}
