"use client";

import React from "react";
import { motion } from "framer-motion";
import { Star, Quote, Zap } from "lucide-react";
import { Badge } from "@/components/ui/Badge";

const testimonials = [
  {
    name: "Rahul Sharma",
    handle: "@rahulsharma_dev",
    avatar: "R",
    avatarBg: "#2DD4BF",
    avatarColor: "#0F0F14",
    role: "Stellar Developer",
    stars: 5,
    text: "Finally a bill-splitting app that doesn't require me to trust a random backend. Everything settles on-chain, the QR codes work perfectly with my wallet. SettleX is exactly what Web3 UX should look like.",
    highlight: "exactly what Web3 UX should look like",
  },
  {
    name: "Priya Menon",
    handle: "@priyam_crypto",
    avatar: "P",
    avatarBg: "#0F0F14",
    avatarColor: "#2DD4BF",
    role: "DeFi Enthusiast",
    stars: 5,
    text: "Used SettleX for our group trip to Goa. 6 people, 22 expenses — it auto-settled everything into 3 transactions. The Stellar fees were basically zero. Can't go back to Splitwise after this.",
    highlight: "auto-settled everything into 3 transactions",
  },
  {
    name: "Alex Donovan",
    handle: "@alexd_blockchain",
    avatar: "A",
    avatarBg: "#1A1A22",
    avatarColor: "#2DD4BF",
    role: "Blockchain Engineer",
    stars: 5,
    text: "The on-chain memo system is clever. Every receipt permanently lives on the Stellar ledger — I clicked the TX hash to verify it myself. For crypto-native users, this is the bill-splitting app.",
    highlight: "every receipt permanently lives on the Stellar ledger",
  },
  {
    name: "Sam Chen",
    handle: "@samchen_xyz",
    avatar: "S",
    avatarBg: "#0D9488",
    avatarColor: "#0F0F14",
    role: "Product Designer",
    stars: 5,
    text: "The design is incredibly clean. Cards feel premium, the lime accent is distinctive, and the Freighter integration is seamless. I shipped this to my whole friend group and they love it.",
    highlight: "The design is incredibly clean",
  },
  {
    name: "Nisha Patel",
    handle: "@nisha_stellar",
    avatar: "N",
    avatarBg: "#2A2A35",
    avatarColor: "#2DD4BF",
    role: "Crypto UX Researcher",
    stars: 5,
    text: "Group trip settlements used to cause drama. With SettleX's auto-settlement algorithm, our 8-person trip needed only 2 transactions. The transparency kills any arguments about who paid what.",
    highlight: "8-person trip needed only 2 transactions",
  },
  {
    name: "Dev Kapoor",
    handle: "@devkapoor_web3",
    avatar: "D",
    avatarBg: "#2DD4BF",
    avatarColor: "#0F0F14",
    role: "Web3 Founder",
    stars: 5,
    text: "Built on Stellar so fees are negligible. Non-custodial so I keep my keys. QR codes so my non-crypto friends can pay too. This is the holy trinity of good crypto UX.",
    highlight: "holy trinity of good crypto UX",
  },
];

const cardVariants = {
  hidden: { opacity: 0, y: 30 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { duration: 0.55, delay: i * 0.08, ease: [0.22, 1, 0.36, 1] },
  }),
};

function HighlightedText({ text, highlight }: { text: string; highlight: string }) {
  const parts = text.split(highlight);
  return (
    <>
      {parts[0]}
      <span className="bg-[#2DD4BF]/20 text-[#134E4A] font-semibold px-0.5 rounded">
        {highlight}
      </span>
      {parts[1]}
    </>
  );
}

export default function Testimonials() {
  return (
    <section className="section-padding bg-[#F6F6F6] relative overflow-hidden">
      {/* Radial */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(185,255,102,0.06), transparent 70%)",
        }}
      />

      <div className="container-max relative">
        {/* Header */}
        <motion.div
          initial={{ opacity: 0, y: 30 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.6 }}
          className="text-center mb-16 max-w-xl mx-auto"
        >
          <Badge variant="lime" className="mb-4">
            <Star size={11} className="fill-current" />
            Loved by early users
          </Badge>
          <h2 className="heading-section text-[#0F0F14] mb-4">
            Real people.{" "}
            <span
              className="bg-clip-text text-transparent"
              style={{
                backgroundImage: "linear-gradient(135deg, #2DD4BF, #0D9488)",
              }}
            >
              Real settlements.
            </span>
          </h2>
          <p className="text-[#666] text-lg">
            From group trips to shared apartments — see what our early community
            is saying about SettleX.
          </p>
        </motion.div>

        {/* Masonry-style grid */}
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-4 space-y-0">
          {testimonials.map((t, i) => (
            <motion.div
              key={t.name}
              custom={i}
              variants={cardVariants}
              initial="hidden"
              whileInView="visible"
              viewport={{ once: true, margin: "-40px" }}
              className="break-inside-avoid mb-4 group"
            >
              <div className="bg-white rounded-3xl border border-[#E5E5E5] p-6 hover:border-[#2DD4BF]/40 hover:shadow-[0_8px_40px_-8px_rgba(0,0,0,0.1)] transition-all duration-300">
                {/* Stars */}
                <div className="flex gap-0.5 mb-4">
                  {[...Array(t.stars)].map((_, s) => (
                    <Star
                      key={s}
                      size={13}
                      className="text-[#2DD4BF] fill-[#2DD4BF]"
                    />
                  ))}
                </div>

                {/* Quote icon */}
                <Quote
                  size={20}
                  className="text-[#E5E5E5] mb-3 group-hover:text-[#2DD4BF]/30 transition-colors"
                />

                {/* Text */}
                <p className="text-[15px] text-[#333] leading-relaxed mb-5">
                  &ldquo;<HighlightedText text={t.text} highlight={t.highlight} />&rdquo;
                </p>

                {/* Author */}
                <div className="flex items-center gap-3">
                  <div
                    className="w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                    style={{
                      backgroundColor: t.avatarBg,
                      color: t.avatarColor,
                    }}
                  >
                    {t.avatar}
                  </div>
                  <div>
                    <p className="text-sm font-bold text-[#0F0F14]">{t.name}</p>
                    <p className="text-xs text-[#AAA]">
                      {t.role} · {t.handle}
                    </p>
                  </div>
                </div>
              </div>
            </motion.div>
          ))}
        </div>

        {/* Bottom trust bar */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.5, delay: 0.2 }}
          className="flex flex-col sm:flex-row items-center justify-center gap-6 mt-12 pt-12 border-t border-[#E5E5E5]"
        >
          {[
            { value: "4.9/5", label: "Average rating" },
            { value: "2,000+", label: "Early users" },
            { value: "0 fees", label: "Platform charges" },
          ].map(({ value, label }) => (
            <div key={label} className="text-center">
              <div className="text-2xl font-black text-[#0F0F14]">{value}</div>
              <div className="text-sm text-[#AAA]">{label}</div>
            </div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
