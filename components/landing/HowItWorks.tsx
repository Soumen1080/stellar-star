"use client";

import React from "react";
import { motion } from "framer-motion";
import {
  Wallet,
  Calculator,
  Send,
  CheckCircle2,
  ArrowRight,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const steps = [
  {
    number: "01",
    icon: Wallet,
    title: "Connect Your Wallet",
    description:
      "Install the Freighter browser extension and click Connect. Your public key is fetched instantly — no email, no password.",
    hint: "Uses Freighter API · Non-custodial",
    color: "#2DD4BF",
  },
  {
    number: "02",
    icon: Calculator,
    title: "Create an Expense",
    description:
      "Add the total amount, list your group members, and choose equal or custom split. SettleX calculates each person's share to 7 decimal XLM precision.",
    hint: "Equal or custom weight splits",
    color: "#2DD4BF",
  },
  {
    number: "03",
    icon: Send,
    title: "Pay via Stellar",
    description:
      "Each person clicks Pay. Freighter pops up with transaction details — destination, amount, and memo. One confirmation and funds move in seconds.",
    hint: "~5 second finality on Stellar",
    color: "#2DD4BF",
  },
  {
    number: "04",
    icon: CheckCircle2,
    title: "Transparent Receipt",
    description:
      "Every payment generates a unique transaction hash permanently recorded on the Stellar ledger. Click to verify on Stellar Explorer.",
    hint: "Immutable on-chain record",
    color: "#2DD4BF",
  },
];

const containerVariants = {
  hidden: {},
  visible: { transition: { staggerChildren: 0.12 } },
};

const itemVariants = {
  hidden: { opacity: 0, x: -20 },
  visible: {
    opacity: 1,
    x: 0,
    transition: { duration: 0.6, ease: [0.22, 1, 0.36, 1] },
  },
};

/* ── Mock Terminal ── */
const MockTerminal = () => (
  <div className="bg-[#0F0F14] rounded-2xl overflow-hidden border border-white/5 shadow-[0_8px_40px_-8px_rgba(0,0,0,0.4)]">
    {/* Terminal header */}
    <div className="flex items-center gap-1.5 px-4 py-3 border-b border-white/5">
      <div className="w-3 h-3 rounded-full bg-[#FF5F57]" />
      <div className="w-3 h-3 rounded-full bg-[#FEBC2E]" />
      <div className="w-3 h-3 rounded-full bg-[#28C840]" />
      <span className="ml-3 text-[#555] text-xs font-mono">SettleX · transaction</span>
    </div>

    {/* Content */}
    <div className="p-5 font-mono text-xs space-y-2">
      <div className="text-[#555]"># Build payment TX</div>
      <div className="text-[#888]">
        <span className="text-[#2DD4BF]">const</span> tx ={" "}
        <span className="text-[#2DD4BF]">await</span> buildPayment(&#123;
      </div>
      <div className="text-[#888] pl-4">
        destination: <span className="text-[#aaa]">&quot;GAKJ...RH4&quot;</span>,
      </div>
      <div className="text-[#888] pl-4">
        amount: <span className="text-[#2DD4BF]">&quot;300.0000000&quot;</span>,
      </div>
      <div className="text-[#888] pl-4">
        memo: <span className="text-[#aaa]">&quot;SettleX|Dinner|Aman&quot;</span>,
      </div>
      <div className="text-[#888]">&#125;);</div>
      <div className="mt-3 text-[#555]"># Sign + submit</div>
      <div className="text-[#888]">
        <span className="text-[#2DD4BF]">const</span> result ={" "}
        <span className="text-[#2DD4BF]">await</span> submit(signedXDR);
      </div>
      <div className="mt-3 pt-3 border-t border-white/5 text-[#2DD4BF]">
        ✓ TX Hash: 4f3a...c8e2
      </div>
      <div className="text-[#2DD4BF]">✓ Ledger: 47,291,034 · Successful</div>
    </div>
  </div>
);

export default function HowItWorks() {
  return (
    <section
      id="how-it-works"
      className="section-padding bg-white relative overflow-hidden border-y border-[#EEEEEE]"
    >
      {/* Faint grid */}
      <div className="absolute inset-0 bg-grid opacity-40 pointer-events-none" />

      <div className="container-max relative">
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-16 lg:gap-20 items-center">
          {/* ── LEFT: Steps ── */}
          <div>
            <motion.div
              initial={{ opacity: 0, y: 20 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ duration: 0.5 }}
              className="mb-10"
            >
              <Badge variant="lime" className="mb-4">
                <Zap size={11} className="fill-current" />
                Simple 4-step flow
              </Badge>
              <h2 className="heading-section text-[#0F0F14] mb-4">
                How SettleX
                <br />
                <span
                  className="bg-clip-text text-transparent"
                  style={{
                    backgroundImage: "linear-gradient(135deg, #2DD4BF, #0D9488)",
                  }}
                >
                  works
                </span>
              </h2>
              <p className="text-[#666] text-lg leading-relaxed">
                From wallet connect to on-chain confirmation — the entire flow
                takes under a minute.
              </p>
            </motion.div>

            <motion.div
              variants={containerVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-60px" }}
              className="space-y-0"
            >
              {steps.map((step, i) => {
                const Icon = step.icon;
                return (
                  <motion.div
                    key={step.number}
                    variants={itemVariants}
                    className="relative flex gap-5 group"
                  >
                    {/* Vertical connector */}
                    {i < steps.length - 1 && (
                      <div className="absolute left-[23px] top-12 bottom-0 w-px bg-gradient-to-b from-[#2DD4BF]/40 to-transparent" />
                    )}

                    {/* Icon circle */}
                    <div className="shrink-0 relative">
                      <div className="w-12 h-12 rounded-2xl bg-[#F6F6F6] border border-[#E5E5E5] flex items-center justify-center group-hover:bg-[#2DD4BF] group-hover:border-[#2DD4BF] transition-all duration-300">
                        <Icon
                          size={20}
                          className="text-[#888] group-hover:text-[#0F0F14] transition-colors duration-300"
                        />
                      </div>
                    </div>

                    {/* Content */}
                    <div className="pb-8">
                      <div className="flex items-center gap-2 mb-1">
                        <span className="text-[10px] font-black text-[#CCC] tracking-widest">
                          {step.number}
                        </span>
                      </div>
                      <h3 className="text-[17px] font-bold text-[#0F0F14] mb-1">
                        {step.title}
                      </h3>
                      <p className="text-sm text-[#666] leading-relaxed mb-2">
                        {step.description}
                      </p>
                      <div className="inline-flex items-center gap-1.5 text-[11px] text-[#134E4A] font-medium">
                        <div className="w-1 h-1 rounded-full bg-[#2DD4BF]" />
                        {step.hint}
                      </div>
                    </div>
                  </motion.div>
                );
              })}
            </motion.div>
          </div>

          {/* ── RIGHT: Visual ── */}
          <motion.div
            initial={{ opacity: 0, x: 40 }}
            whileInView={{ opacity: 1, x: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
            className="space-y-4"
          >
            <MockTerminal />

            {/* Architecture diagram */}
            <div className="bg-[#F6F6F6] rounded-2xl border border-[#E5E5E5] p-5">
              <p className="text-xs font-semibold uppercase tracking-widest text-[#AAA] mb-4">
                Data Flow
              </p>
              <div className="flex items-center gap-2 flex-wrap">
                {[
                  "User Action",
                  "React State",
                  "Stellar SDK",
                  "Freighter Sign",
                  "Horizon",
                  "Ledger ✓",
                ].map((step, i, arr) => (
                  <React.Fragment key={step}>
                    <div className="bg-white border border-[#E5E5E5] rounded-xl px-3 py-1.5 text-xs font-medium text-[#0F0F14] whitespace-nowrap">
                      {step}
                    </div>
                    {i < arr.length - 1 && (
                      <ArrowRight size={12} className="text-[#2DD4BF] shrink-0" />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </div>

            {/* Network stats */}
            <div className="grid grid-cols-2 gap-3">
              {[
                { label: "Avg TX Fee", value: "0.00001 XLM", sub: "~$0.000002" },
                { label: "Settlement Time", value: "~5 seconds", sub: "Stellar Network" },
                { label: "TX Precision", value: "7 decimals", sub: "Native XLM" },
                { label: "Network", value: "Testnet", sub: "→ Mainnet ready" },
              ].map((stat) => (
                <div
                  key={stat.label}
                  className="bg-white rounded-2xl border border-[#E5E5E5] p-4"
                >
                  <p className="text-[11px] text-[#AAA] font-medium uppercase tracking-wider mb-1">
                    {stat.label}
                  </p>
                  <p className="text-base font-bold text-[#0F0F14]">{stat.value}</p>
                  <p className="text-[11px] text-[#AAA]">{stat.sub}</p>
                </div>
              ))}
            </div>
          </motion.div>
        </div>
      </div>
    </section>
  );
}
