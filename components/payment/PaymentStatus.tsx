"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, Loader2, Database } from "lucide-react";
import { TransactionHash } from "./TransactionHash";
import type { PaymentState } from "@/hooks/usePayment";
import { cn } from "@/lib/utils";

interface PaymentStatusProps {
  state: PaymentState;
  onReset?: () => void;
  onRetryOnChain?: () => void;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  building:   "Building transaction…",
  signing:    "Waiting for wallet signature…",
  submitting: "Submitting to Stellar network…",
  recording:  "Recording payment on-chain…",
};

const RECORDING_STEP_LABELS: Record<string, string> = {
  simulating: "Simulating contract call…",
  signing: "Preparing signed contract transaction…",
  sending: "Sending contract transaction…",
  confirming: "Confirming on-chain settlement…",
};

export function PaymentStatus({ state, onReset, onRetryOnChain, className }: PaymentStatusProps) {
  const isLoadingState =
    state.status === "building" ||
    state.status === "signing" ||
    state.status === "submitting" ||
    state.status === "recording";

  return (
    <AnimatePresence mode="wait">
      {state.status === "idle" ? null : (
        <motion.div
          key={state.status}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={cn("rounded-xl border p-4", className, {
            "bg-[#F0FDFA] border-[#2DD4BF]/40": state.status === "success",
            "bg-red-50 border-red-200":          state.status === "error",
            "bg-[#F8F8F8] border-[#E5E5E5]":    isLoadingState,
          })}
        >
          {/* Loading states: building / signing / submitting / recording */}
          {isLoadingState && (
            <div className="flex items-center gap-3">
              {state.status === "recording" ? (
                <Database size={16} className="animate-pulse text-[#888] shrink-0" />
              ) : (
                <Loader2 size={16} className="animate-spin text-[#888] shrink-0" />
              )}
              <div>
                <p className="text-sm font-medium text-[#555]">
                  {state.status === "recording"
                    ? RECORDING_STEP_LABELS[state.step] ?? STATUS_LABELS[state.status]
                    : STATUS_LABELS[state.status]}
                </p>
                {state.status === "recording" && (
                  <p className="text-[11px] text-[#AAA] mt-0.5">
                    Storing settlement proof in the Soroban contract pool flow…
                  </p>
                )}
              </div>
            </div>
          )}

          {/* Success */}
          {state.status === "success" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <CheckCircle2 size={16} className="text-[#134E4A] shrink-0" />
                <p className="text-sm font-bold text-[#134E4A]">Payment successful!</p>
                {state.onChain && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-[#2DD4BF]/30 text-[#134E4A]">
                    <Database size={9} />
                    On-chain
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[#888]">TX:</span>
                <TransactionHash hash={state.hash} compact />
              </div>
              {onReset && (
                <button
                  onClick={onReset}
                  className="text-xs text-[#AAA] hover:text-[#555] transition-colors mt-1"
                >
                  Dismiss
                </button>
              )}
            </div>
          )}

          {/* Partial success: XLM sent, contract recording pending */}
          {state.status === "partial_success" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 flex-wrap">
                <CheckCircle2 size={16} className="text-[#7A5B00] shrink-0" />
                <p className="text-sm font-bold text-[#7A5B00]">Payment sent, contract record pending</p>
                <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide px-2 py-0.5 rounded-md bg-amber-100 text-amber-700">
                  Retry available
                </span>
              </div>

              <p className="text-xs text-amber-700">{state.message}</p>

              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-xs text-[#888]">TX:</span>
                <TransactionHash hash={state.hash} compact />
              </div>

              <div className="flex items-center gap-2 flex-wrap mt-1">
                {onRetryOnChain && (
                  <button
                    onClick={onRetryOnChain}
                    className="text-xs font-semibold px-3 py-1 rounded-lg bg-amber-100 text-amber-800 hover:bg-amber-200 transition-colors"
                  >
                    Retry on-chain record
                  </button>
                )}
                {onReset && (
                  <button
                    onClick={onReset}
                    className="text-xs text-[#AAA] hover:text-[#555] transition-colors"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {state.status === "error" && (
            <div className="flex items-start gap-2">
              <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-red-600">Payment failed</p>
                <p className="text-xs text-red-500 mt-0.5">{state.message}</p>
                {onReset && (
                  <button
                    onClick={onReset}
                    className="text-xs text-red-400 hover:text-red-600 underline mt-1 transition-colors"
                  >
                    Try again
                  </button>
                )}
              </div>
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
