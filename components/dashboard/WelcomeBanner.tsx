"use client";

import { motion } from "framer-motion";
import { formatAddress } from "@/lib/utils";
import { NETWORK_DISPLAY_NAME } from "@/lib/utils/constants";

interface WelcomeBannerProps {
  displayName?: string | null;
  publicKey?: string | null;
}

export function WelcomeBanner({ displayName, publicKey }: WelcomeBannerProps) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45 }}
      className="bg-[#0F0F14] rounded-3xl p-5 sm:p-8 mb-6 relative overflow-hidden"
    >
      <div
        className="absolute inset-0 rounded-3xl pointer-events-none"
        style={{ background: "radial-gradient(ellipse 80% 50% at 50% 0%, rgba(185,255,102,0.1), transparent)" }}
      />
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 h-px w-1/2 pointer-events-none"
        style={{ background: "linear-gradient(90deg, transparent, #2DD4BF, transparent)" }}
      />
      <div className="relative flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <div className="inline-flex items-center gap-2 px-3 py-1 bg-[#2DD4BF]/10 border border-[#2DD4BF]/20 rounded-full text-xs font-semibold text-[#2DD4BF] mb-3">
            <span className="w-1.5 h-1.5 rounded-full bg-[#2DD4BF] animate-pulse" />
            Wallet Connected &middot; {NETWORK_DISPLAY_NAME}
          </div>
          <h2 className="text-xl sm:text-2xl font-black text-white mb-1">
            Welcome,{" "}
            <span className="text-[#2DD4BF]">
              {displayName || (publicKey ? formatAddress(publicKey, 5) : "...")}
            </span>
          </h2>
          <p className="text-[#666] text-sm">Split expenses, pay with XLM, and track settlements on-chain.</p>
        </div>
      </div>
    </motion.div>
  );
}
