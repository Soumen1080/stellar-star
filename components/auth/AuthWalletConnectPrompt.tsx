"use client";

import { motion } from "framer-motion";
import type { ElementType } from "react";
import { ArrowRight, CheckCircle2, Shield, Wallet, Zap } from "lucide-react";
import { Button } from "@/components/ui/Button";

interface AuthWalletConnectPromptProps {
  onConnect: () => void;
}

export function AuthWalletConnectPrompt({ onConnect }: AuthWalletConnectPromptProps) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F6F6F6] px-4 py-8">
      <div className="absolute inset-0 bg-hero-grid bg-[length:40px_40px] opacity-40" />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative max-w-lg w-full bg-white rounded-3xl shadow-[0_8px_60px_-12px_rgba(0,0,0,0.25)] p-6 sm:p-10"
      >
        <div className="text-center mb-8">
          <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-[#2DD4BF]/15 border border-[#2DD4BF]/30 rounded-full text-xs font-semibold text-[#134E4A] mb-6">
            <Shield size={14} />
            Secure Wallet Authentication
          </div>
          <h1 className="text-3xl sm:text-4xl font-black text-[#0F0F14] mb-3">Welcome to Stellar-star</h1>
          <p className="text-[#666] text-base leading-relaxed">Connect your Stellar wallet to get started</p>
        </div>

        <div className="space-y-4 mb-8">
          <AuthBenefit icon={CheckCircle2} title="No passwords needed" text="Your wallet is your identity" />
          <AuthBenefit icon={Zap} title="Instant authentication" text="Sign in with one click" />
        </div>

        <Button
          onClick={onConnect}
          className="w-full bg-[#0F0F14] text-white hover:bg-[#2a2a2f] h-14 text-base font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
        >
          <Wallet size={20} />
          Connect Wallet
          <ArrowRight size={18} />
        </Button>

        <div className="mt-8 text-center">
          <p className="text-sm text-[#888] mb-2">Don&apos;t have Freighter wallet?</p>
          <a
            href="https://www.freighter.app/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-semibold text-[#0F0F14] hover:text-[#2DD4BF] transition-colors inline-flex items-center gap-1"
          >
            Download here
            <ArrowRight size={14} />
          </a>
        </div>
      </motion.div>
    </div>
  );
}

interface AuthBenefitProps {
  icon: ElementType;
  title: string;
  text: string;
}

function AuthBenefit({ icon: Icon, title, text }: AuthBenefitProps) {
  return (
    <div className="flex items-center gap-3 p-4 bg-[#F6F6F6] rounded-xl">
      <div className="w-10 h-10 rounded-xl bg-[#2DD4BF]/20 flex items-center justify-center">
        <Icon size={20} className="text-[#134E4A]" />
      </div>
      <div className="flex-1">
        <p className="text-sm font-semibold text-[#0F0F14]">{title}</p>
        <p className="text-xs text-[#888]">{text}</p>
      </div>
    </div>
  );
}
