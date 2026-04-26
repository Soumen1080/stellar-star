"use client";

import React, { useState } from "react";
import { useAuth } from "@/context/AuthContext";
import { useWalletContext } from "@/context/WalletContext";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { useRouter } from "next/navigation";
import { useToast } from "@/components/ui/Toast";
import { motion } from "framer-motion";
import { Wallet, User, ArrowRight, CheckCircle2, Shield, Zap } from "lucide-react";

export default function AuthPage() {
  const { signUp, signIn, isLoading } = useAuth();
  const { publicKey, isConnected, connect } = useWalletContext();
  const [displayName, setDisplayName] = useState("");
  const [isSignUpMode, setIsSignUpMode] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState("");
  const router = useRouter();
  const { success, error: showError } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    // Validate name for sign up
    if (isSignUpMode && !displayName.trim()) {
      setError("Please enter your name");
      return;
    }

    setIsSubmitting(true);

    try {
      if (isSignUpMode) {
        await signUp(displayName.trim());
        success("Account created successfully!");
      } else {
        await signIn();
        success("Welcome back!");
      }
      router.push("/dashboard");
    } catch (err: any) {
      const msg: string = err?.message || "";
      // Wallet already registered → auto-switch to Sign In
      if (
        isSignUpMode &&
        (msg.includes("already registered") ||
          msg.includes("sign in instead") ||
          msg.includes("23505"))
      ) {
        setIsSignUpMode(false);
        setError("This wallet already has an account. Please sign in.");
      } else if (msg) {
        setError(msg);
      } else {
        setError(isSignUpMode ? "Sign up failed. Please try again." : "Sign in failed. Please try again.");
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (!isConnected) {
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
            <h1 className="text-3xl sm:text-4xl font-black text-[#0F0F14] mb-3">Welcome to SettleX</h1>
            <p className="text-[#666] text-base leading-relaxed">
              Connect your Stellar wallet to get started
            </p>
          </div>

          <div className="space-y-4 mb-8">
            <div className="flex items-center gap-3 p-4 bg-[#F6F6F6] rounded-xl">
              <div className="w-10 h-10 rounded-xl bg-[#2DD4BF]/20 flex items-center justify-center">
                <CheckCircle2 size={20} className="text-[#134E4A]" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#0F0F14]">No passwords needed</p>
                <p className="text-xs text-[#888]">Your wallet is your identity</p>
              </div>
            </div>
            <div className="flex items-center gap-3 p-4 bg-[#F6F6F6] rounded-xl">
              <div className="w-10 h-10 rounded-xl bg-[#2DD4BF]/20 flex items-center justify-center">
                <Zap size={20} className="text-[#134E4A]" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-semibold text-[#0F0F14]">Instant authentication</p>
                <p className="text-xs text-[#888]">Sign in with one click</p>
              </div>
            </div>
          </div>

          <Button
            onClick={connect}
            className="w-full bg-[#0F0F14] text-white hover:bg-[#2a2a2f] h-14 text-base font-bold rounded-xl flex items-center justify-center gap-2 transition-all"
          >
            <Wallet size={20} />
            Connect Freighter Wallet
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

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#F6F6F6] px-4 py-12">
      <div className="absolute inset-0 bg-hero-grid bg-[length:40px_40px] opacity-40" />
      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="relative max-w-lg w-full bg-white rounded-3xl shadow-[0_8px_60px_-12px_rgba(0,0,0,0.25)] p-6 sm:p-10"
      >
        <div className="text-center mb-8">
          <h1 className="text-3xl sm:text-4xl font-black text-[#0F0F14] mb-2">
            {isSignUpMode ? "Create Account" : "Welcome Back"}
          </h1>
          <p className="text-[#666] text-base">
            {isSignUpMode ? "Join SettleX and start splitting bills" : "Sign in to your account"}
          </p>
        </div>

        {/* Wallet Address Display */}
        <div className="mb-6 p-5 bg-gradient-to-br from-[#F6F6F6] to-[#FAFAFA] rounded-2xl border border-[#E5E5E5]">
          <div className="flex items-center gap-3 mb-2">
            <div className="w-8 h-8 rounded-lg bg-[#2DD4BF]/20 flex items-center justify-center">
              <Wallet size={16} className="text-[#134E4A]" />
            </div>
            <p className="text-xs font-semibold text-[#888] uppercase tracking-wider">Connected Wallet</p>
          </div>
          <p className="text-sm font-mono text-[#0F0F14] break-all bg-white px-3 py-2 rounded-lg">
            {publicKey}
          </p>
        </div>

        {/* Toggle Sign Up / Sign In */}
        <div className="flex gap-2 mb-6 p-1 bg-[#F6F6F6] rounded-xl">
          <button
            type="button"
            onClick={() => {
              setIsSignUpMode(true);
              setError("");
            }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
              isSignUpMode
                ? "bg-white text-[#0F0F14] shadow-sm"
                : "text-[#888] hover:text-[#0F0F14]"
            }`}
          >
            Sign Up
          </button>
          <button
            type="button"
            onClick={() => {
              setIsSignUpMode(false);
              setError("");
            }}
            className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
              !isSignUpMode
                ? "bg-white text-[#0F0F14] shadow-sm"
                : "text-[#888] hover:text-[#0F0F14]"
            }`}
          >
            Sign In
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          {/* Name Field - Only for Sign Up */}
          {isSignUpMode && (
            <div>
              <label className="block text-sm font-semibold text-[#0F0F14] mb-2">
                Your Name <span className="text-[#FF6B6B]">*</span>
              </label>
              <div className="relative">
                <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#888]" />
                <Input
                  type="text"
                  placeholder="Enter your full name"
                  value={displayName}
                  onChange={(e) => {
                    setDisplayName(e.target.value);
                    setError("");
                  }}
                  className="w-full pl-12 h-12 rounded-xl border-2 border-[#E5E5E5] focus:border-[#2DD4BF] transition-colors"
                  required
                />
              </div>
              <p className="text-xs text-[#888] mt-2">This name will be visible to other members</p>
            </div>
          )}

          {/* Error Message */}
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-[#FF6B6B]/10 border border-[#FF6B6B]/30 rounded-xl"
            >
              <p className="text-sm font-medium text-[#FF6B6B]">{error}</p>
            </motion.div>
          )}

          <Button
            type="submit"
            disabled={isSubmitting || isLoading}
            className="w-full bg-[#0F0F14] text-white hover:bg-[#2a2a2f] h-14 text-base font-bold rounded-xl transition-all flex items-center justify-center gap-2"
          >
            {isSubmitting ? (
              <span>Processing...</span>
            ) : (
              <>
                {isSignUpMode ? "Create Account" : "Sign In"}
                <ArrowRight size={18} />
              </>
            )}
          </Button>
        </form>

        <p className="mt-8 text-xs text-center text-[#888] leading-relaxed">
          Your wallet address is your identity. No passwords needed.
          <br />
          {isSignUpMode ? "Already have an account?" : "New to SettleX?"} Use the toggle above.
        </p>
      </motion.div>
    </div>
  );
}
