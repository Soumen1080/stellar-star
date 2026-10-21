"use client";

import type { FormEvent } from "react";
import { motion } from "framer-motion";
import { ArrowRight, LogOut, User, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";

interface AuthAccountFormProps {
  publicKey?: string | null;
  displayName: string;
  isSignUpMode: boolean;
  isSubmitting: boolean;
  isLoading: boolean;
  error: string;
  onDisplayNameChange: (value: string) => void;
  onModeChange: (isSignUpMode: boolean) => void;
  onSubmit: (event: FormEvent) => void;
  onDisconnect?: () => void;
}

export function AuthAccountForm({
  publicKey,
  displayName,
  isSignUpMode,
  isSubmitting,
  isLoading,
  error,
  onDisplayNameChange,
  onModeChange,
  onSubmit,
  onDisconnect,
}: AuthAccountFormProps) {
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
            {isSignUpMode ? "Join Stellar-star and start splitting bills" : "Sign in to your account"}
          </p>
        </div>

        <ConnectedWallet publicKey={publicKey} onDisconnect={onDisconnect} />
        <AuthModeToggle isSignUpMode={isSignUpMode} onModeChange={onModeChange} />

        <form onSubmit={onSubmit} className="space-y-5">
          {isSignUpMode && (
            <div>
              <div className="relative">
                <User size={18} className="absolute left-4 top-1/2 -translate-y-1/2 text-[#888]" />
                <Input
                  label="Your name"
                  type="text"
                  placeholder="Enter your full name"
                  value={displayName}
                  onChange={(event) => onDisplayNameChange(event.target.value)}
                  className="w-full pl-12 h-12 rounded-xl border-2 border-[#E5E5E5] focus:border-[#2DD4BF] transition-colors"
                  required
                />
              </div>
              <p className="text-xs text-[#888] mt-2">This name will be visible to other members</p>
            </div>
          )}

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -10 }}
              animate={{ opacity: 1, y: 0 }}
              className="p-4 bg-[#FF6B6B]/10 border border-[#FF6B6B]/30 rounded-xl"
            >
              <p role="alert" className="text-sm font-medium text-red-700">{error}</p>
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
          {isSignUpMode ? "Already have an account?" : "New to Stellar-star?"} Use the toggle above.
        </p>
      </motion.div>
    </div>
  );
}

function ConnectedWallet({ publicKey, onDisconnect }: { publicKey?: string | null; onDisconnect?: () => void }) {
  return (
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
      {onDisconnect && (
        <Button
          type="button"
          onClick={onDisconnect}
          className="mt-4 w-full border border-[#E5E5E5] bg-white text-[#0F0F14] hover:bg-[#F6F6F6] h-11 text-sm font-semibold rounded-xl transition-all flex items-center justify-center gap-2"
        >
          <LogOut size={16} />
          Disconnect Wallet
        </Button>
      )}
    </div>
  );
}

interface AuthModeToggleProps {
  isSignUpMode: boolean;
  onModeChange: (isSignUpMode: boolean) => void;
}

function AuthModeToggle({ isSignUpMode, onModeChange }: AuthModeToggleProps) {
  return (
    <div className="flex gap-2 mb-6 p-1 bg-[#F6F6F6] rounded-xl">
      <button
        type="button"
        onClick={() => onModeChange(true)}
        className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
          isSignUpMode ? "bg-white text-[#0F0F14] shadow-sm" : "text-[#888] hover:text-[#0F0F14]"
        }`}
      >
        Sign Up
      </button>
      <button
        type="button"
        onClick={() => onModeChange(false)}
        className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all ${
          !isSignUpMode ? "bg-white text-[#0F0F14] shadow-sm" : "text-[#888] hover:text-[#0F0F14]"
        }`}
      >
        Sign In
      </button>
    </div>
  );
}
