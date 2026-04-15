"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { CheckCircle2, Zap, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";

const plans = [
  {
    name: "Free",
    price: "0",
    period: "forever",
    description: "Everything you need to split bills with your group on Stellar Testnet.",
    features: [
      "Unlimited expenses",
      "Up to 20 members per group",
      "Equal & custom splits",
      "QR code payments",
      "On-chain receipts",
      "Trip mode",
      "Auto-settlement algorithm",
      "Stellar Explorer links",
    ],
    cta: "Get Started",
    href: "/dashboard",
    accent: false,
    badge: "Always Free",
  },
  {
    name: "Mainnet",
    price: "0",
    period: "per transaction",
    description: "Same app, real XLM. Settle real expenses with real payments on Stellar Mainnet.",
    features: [
      "Everything in Free",
      "Stellar Mainnet support",
      "Real XLM payments",
      "~0.00001 XLM network fee",
      "No Stellar Star platform fees",
      "Full Horizon API access",
      "Immutable mainnet receipts",
      "Priority Freighter support",
    ],
    cta: "Coming Soon",
    href: "#",
    accent: true,
    badge: "Mainnet Soon",
  },
];

export default function Pricing() {
  return (
    <section id="pricing" className="section-padding bg-white border-y border-[#EEEEEE] relative overflow-hidden">
      <div className="absolute inset-0 bg-grid opacity-30 pointer-events-none" />

      <div className="container-max relative">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-14 max-w-lg mx-auto"
        >
          <Badge variant="lime" className="mb-4">
            <Zap size={11} className="fill-current" />
            Simple pricing
          </Badge>
          <h2 className="heading-section text-[#0F0F14] mb-4">
            Transparent like{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(135deg, #2DD4BF, #0D9488)" }}
            >
              the blockchain.
            </span>
          </h2>
          <p className="text-[#666] text-lg">
            Stellar Star charges zero platform fees. You only pay the tiny Stellar
            network fee — currently less than $0.000002 per transaction.
          </p>
        </motion.div>

        {/* Plans */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 max-w-4xl mx-auto">
          {plans.map((plan, i) => (
            <motion.div
              key={plan.name}
              initial={{ opacity: 0, y: 30 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.55, delay: i * 0.1 }}
              className={`relative rounded-3xl p-8 border transition-all duration-300 hover:-translate-y-1 ${
                plan.accent
                  ? "bg-[#0F0F14] border-white/5 hover:border-[#2DD4BF]/30 hover:shadow-[0_12px_60px_-12px_rgba(0,0,0,0.5)]"
                  : "bg-[#F6F6F6] border-[#E5E5E5] hover:border-[#2DD4BF]/40 hover:shadow-[0_12px_60px_-12px_rgba(0,0,0,0.1)]"
              }`}
            >
              {/* Dark card glow */}
              {plan.accent && (
                <div
                  className="absolute inset-0 rounded-3xl pointer-events-none"
                  style={{
                    background:
                      "radial-gradient(ellipse 80% 40% at 50% 0%, rgba(185,255,102,0.07), transparent)",
                  }}
                />
              )}

              {/* Lime top bar for accent card */}
              {plan.accent && (
                <div
                  className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-2/3"
                  style={{
                    background: "linear-gradient(90deg, transparent, #2DD4BF, transparent)",
                  }}
                />
              )}

              <div className="relative">
                {/* Badge */}
                <div className={`inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest mb-4 ${plan.accent ? "text-[#2DD4BF]" : "text-[#AAA]"}`}>
                  <div className={`w-1.5 h-1.5 rounded-full ${plan.accent ? "bg-[#2DD4BF] animate-pulse" : "bg-[#CCC]"}`} />
                  {plan.badge}
                </div>

                {/* Name + price */}
                <div className="flex items-baseline gap-2 mb-1">
                  <span className={`text-4xl font-black ${plan.accent ? "text-white" : "text-[#0F0F14]"}`}>
                    {plan.name}
                  </span>
                </div>
                <div className="flex items-baseline gap-1.5 mb-4">
                  <span className={`text-5xl font-black ${plan.accent ? "text-[#2DD4BF]" : "text-[#0F0F14]"}`}>
                    ${plan.price}
                  </span>
                  <span className={`text-sm ${plan.accent ? "text-[#666]" : "text-[#AAA]"}`}>
                    / {plan.period}
                  </span>
                </div>

                <p className={`text-sm leading-relaxed mb-6 ${plan.accent ? "text-[#666]" : "text-[#555]"}`}>
                  {plan.description}
                </p>

                {/* CTA */}
                {plan.accent ? (
                  <div className="w-full py-3 rounded-2xl bg-white/5 border border-white/10 text-[#555] text-sm font-semibold text-center mb-6">
                    Coming Soon
                  </div>
                ) : (
                  <Button variant="primary" size="md" className="w-full mb-6" asChild>
                    <Link href={plan.href}>
                      {plan.cta}
                      <ArrowRight size={16} />
                    </Link>
                  </Button>
                )}

                {/* Divider */}
                <div className={`h-px mb-6 ${plan.accent ? "bg-white/5" : "bg-[#E5E5E5]"}`} />

                {/* Features */}
                <ul className="space-y-3">
                  {plan.features.map((feature) => (
                    <li key={feature} className="flex items-start gap-2.5">
                      <CheckCircle2
                        size={15}
                        className={`mt-0.5 shrink-0 ${plan.accent ? "text-[#2DD4BF]" : "text-[#134E4A]"}`}
                      />
                      <span className={`text-sm ${plan.accent ? "text-[#888]" : "text-[#555]"}`}>
                        {feature}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Fee note */}
        <motion.p
          initial={{ opacity: 0 }}
          whileInView={{ opacity: 1 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.3 }}
          className="text-center text-sm text-[#AAA] mt-8"
        >
          * Stellar network fee: 100 stroops (0.00001 XLM) per transaction, paid to the Stellar validators.
          Stellar Star charges nothing.
        </motion.p>
      </div>
    </section>
  );
}
