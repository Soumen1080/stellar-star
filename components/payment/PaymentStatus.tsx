"use client";

import React from "react";
import { motion, AnimatePresence } from "framer-motion";
import { CheckCircle2, XCircle, Loader2, Database, AlertCircle } from "lucide-react";
import { TransactionHash } from "./TransactionHash";
import type { PaymentState } from "@/hooks/usePayment";
import { cn } from "@/lib/utils";
import { categorizeError } from "@/lib/observability/errorTaxonomy";

interface PaymentStatusProps {
  state: PaymentState;
  onReset?: () => void;
  onRetryOnChain?: () => void;
  className?: string;
}

const STATUS_LABELS: Record<string, string> = {
  building:   "Building transaction...",
  signing:    "Waiting for wallet signature...",
  submitting: "Submitting to Stellar network...",
  recording:  "Recording payment on-chain...",
};

const RECORDING_STEP_LABELS: Record<string, string> = {
  simulating: "Simulating contract call...",
  signing: "Preparing signed contract transaction...",
  sending: "Sending contract transaction...",
  confirming: "Confirming on-chain settlement...",
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
            "bg-amber-50 border-amber-200":      state.status === "blocked",
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
                    Storing settlement proof in the Soroban contract pool flow...
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

          {/* Blocked before wallet transfer */}
          {state.status === "blocked" && (
            <div className="flex items-start gap-2">
              <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
              <div>
                <p className="text-sm font-bold text-amber-800">Pool credit required</p>
                <p className="text-xs text-amber-700 mt-0.5">{state.message}</p>
                {onReset && (
                  <button
                    onClick={onReset}
                    className="text-xs text-amber-700 hover:text-amber-900 underline mt-1 transition-colors"
                  >
                    Dismiss
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Error */}
          {state.status === "error" && (() => {
            const cat = categorizeError(state.message);
            return (
              <div className="flex items-start gap-2">
                {cat.category === "ambiguous_submission" ? (
                  <AlertCircle size={16} className="text-amber-600 shrink-0 mt-0.5" />
                ) : (
                  <XCircle size={16} className="text-red-500 shrink-0 mt-0.5" />
                )}
                <div>
                  <p className={cn("text-sm font-bold", {
                    "text-amber-800": cat.category === "ambiguous_submission",
                    "text-red-600": cat.category !== "ambiguous_submission",
                  })}>
                    {cat.title}
                  </p>
                  <p className={cn("text-xs mt-0.5", {
                    "text-amber-700": cat.category === "ambiguous_submission",
                    "text-red-500": cat.category !== "ambiguous_submission",
                  })}>
                    {cat.copy}
                  </p>
                  {onReset && (
                    <button
                      onClick={onReset}
                      className={cn("text-xs underline mt-1 transition-colors block", {
                        "text-amber-700 hover:text-amber-900": cat.category === "ambiguous_submission",
                        "text-red-400 hover:text-red-600": cat.category !== "ambiguous_submission",
                      })}
                    >
                      {cat.safeToRetry ? "Try again" : "Dismiss"}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
