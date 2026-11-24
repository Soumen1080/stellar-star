"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
import {
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Wallet,
  Globe,
  Coins,
  FileText,
  KeyRound,
  CheckCheck,
  RotateCcw,
  Sparkles,
  ShieldAlert,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { useWallet } from "@/hooks/useWallet";
import { parseAssetKey, isNative, type AssetRef } from "@/lib/stellar/assets";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

export interface FirstSettlementChecklistProps {
  assetKey?: string;
  amount?: string;
  recipientAddress?: string;
  isAssetReady?: boolean;
  txHash?: string | null;
  hasRecoveryIssue?: boolean;
  onRefreshStatus?: () => void;
  className?: string;
}

export type ChecklistStepKey =
  | "wallet_connection"
  | "network_valid"
  | "asset_readiness"
  | "payment_review"
  | "signature_ready"
  | "confirmation_status"
  | "recovery_status";

interface ChecklistStepState {
  key: ChecklistStepKey;
  title: string;
  plainCopy: string;
  helpTopic: string;
  helpTitle: string;
  status: "complete" | "action_required" | "pending" | "ready";
  icon: LucideIcon;
  detail: string;
}

export function FirstSettlementChecklist({
  assetKey = "native",
  amount,
  recipientAddress,
  isAssetReady = true,
  txHash = null,
  hasRecoveryIssue = false,
  onRefreshStatus,
  className = "",
}: FirstSettlementChecklistProps) {
  const { isConnected, network, appNetwork, networkMismatch, connect } = useWallet();
  const [expandedStep, setExpandedStep] = useState<ChecklistStepKey | null>("wallet_connection");
  const [isDismissed, setIsDismissed] = useState(false);
  const checklistId = useId();

  const isNativeAsset = isNative(parseAssetKey(assetKey));

  // Determine readiness for each of the 7 required steps:
  // 1. Wallet connection
  const walletConnected = isConnected;

  // 2. Network matching
  const networkValid = walletConnected && !networkMismatch;

  // 3. Asset readiness
  const assetReady = walletConnected && networkValid && isAssetReady;

  // 4. Review
  const reviewReady = Boolean(amount && recipientAddress);

  // 5. Signature readiness
  const signatureReady = walletConnected && networkValid && assetReady && reviewReady;

  // 6. Confirmation status
  const confirmationComplete = Boolean(txHash);

  // 7. Recovery status
  const recoveryClear = !hasRecoveryIssue;

  // Analytics on start
  useEffect(() => {
    trackAnalyticsEvent("first_settlement_checklist_started", {
      context: "trip",
    });
  }, []);

  const steps: ChecklistStepState[] = [
    {
      key: "wallet_connection",
      title: "1. Wallet Connection",
      plainCopy: "Your wallet signs settlements directly from your control.",
      helpTopic: "wallet-setup",
      helpTitle: "Connecting Freighter or Albedo",
      status: walletConnected ? "complete" : "action_required",
      icon: Wallet,
      detail: walletConnected
        ? "Wallet connected and ready."
        : "No wallet is connected. Connect your wallet to begin settlement.",
    },
    {
      key: "network_valid",
      title: "2. Network Synchronization",
      plainCopy: "Transactions must be signed on the same Stellar network as the trip.",
      helpTopic: "network-selection",
      helpTitle: "Testnet vs. Public Mainnet",
      status: !walletConnected
        ? "pending"
        : networkMismatch
        ? "action_required"
        : "complete",
      icon: Globe,
      detail: !walletConnected
        ? "Connect your wallet first to inspect network."
        : networkMismatch
        ? `Wallet is on ${network || "an unknown network"}, but this trip runs on ${appNetwork}. Switch your wallet network.`
        : `Connected to ${appNetwork || "correct network"}.`,
    },
    {
      key: "asset_readiness",
      title: "3. Asset & Trustline Readiness",
      plainCopy:
        "Stellar requires accounts to maintain small reserve balances and trustlines for non-XLM assets (like USDC).",
      helpTopic: "trustlines",
      helpTitle: "Setting up trustlines",
      status: !walletConnected || networkMismatch
        ? "pending"
        : assetReady
        ? "complete"
        : "action_required",
      icon: Coins,
      detail: !walletConnected || networkMismatch
        ? "Waiting for wallet and network checks."
        : assetReady
        ? isNativeAsset
          ? "Native XLM is ready for payment and transaction fees."
          : "Trustline verified and balance is ready."
        : isNativeAsset
        ? "Account balance or base reserve needs funding before transacting."
        : "Add a trustline or ensure enough spendable balance before settling.",
    },
    {
      key: "payment_review",
      title: "4. Payment Review",
      plainCopy: "Verify the exact net amount, recipient, and payment memo before submitting.",
      helpTopic: "payment-review",
      helpTitle: "How group net debts are calculated",
      status: !signatureReady
        ? "pending"
        : reviewReady
        ? "complete"
        : "action_required",
      icon: FileText,
      detail: reviewReady
        ? "Recipient address, currency asset, and net share verified."
        : "Select a payment row to review details.",
    },
    {
      key: "signature_ready",
      title: "5. Signature Readiness",
      plainCopy: "When you click Pay, your wallet extension prompts you to review and sign.",
      helpTopic: "wallet-signing",
      helpTitle: "Approving transactions safely",
      status: !reviewReady
        ? "pending"
        : signatureReady
        ? "ready"
        : "action_required",
      icon: KeyRound,
      detail: signatureReady
        ? "All prerequisites cleared. Ready to sign when you initiate payment."
        : "Resolve prior setup items to enable safe signing.",
    },
    {
      key: "confirmation_status",
      title: "6. On-Chain Confirmation",
      plainCopy: "Stellar ledgers confirm transactions in 3–5 seconds with immutable proofs.",
      helpTopic: "settlement-proofs",
      helpTitle: "Verifying on Stellar Expert",
      status: confirmationComplete
        ? "complete"
        : "pending",
      icon: CheckCheck,
      detail: confirmationComplete
        ? `Payment verified on ledger. Hash: ${txHash?.slice(0, 10)}…`
        : "Awaiting payment submission and block inclusion.",
    },
    {
      key: "recovery_status",
      title: "7. Recovery & Audit Status",
      plainCopy: "Detects incomplete network submissions or failed ledger entries so you can safely retry.",
      helpTopic: "recovery-guarantees",
      helpTitle: "Ambiguous transaction recovery",
      status: hasRecoveryIssue
        ? "action_required"
        : recoveryClear
        ? "complete"
        : "pending",
      icon: RotateCcw,
      detail: hasRecoveryIssue
        ? "An ambiguous or interrupted payment was detected. Safe to retry or reconcile below."
        : "No pending or failed transactions. Recovery state is clean.",
    },
  ];

  const completedCount = steps.filter((s) => s.status === "complete").length;
  const hasIncompleteSetup = steps.some(
    (s) => s.status === "action_required" && (s.key === "wallet_connection" || s.key === "network_valid" || s.key === "asset_readiness")
  );

  const toggleStep = (key: ChecklistStepKey) => {
    const isExpanding = expandedStep !== key;
    setExpandedStep(isExpanding ? key : null);
    if (isExpanding) {
      const stepIdx = steps.findIndex((s) => s.key === key);
      trackAnalyticsEvent("first_settlement_checklist_step_completed", {
        step_key: key,
        step_index: stepIdx + 1,
      });
    }
  };

  const handleDismiss = () => {
    setIsDismissed(true);
    const incompleteCount = steps.filter((s) => s.status !== "complete").length;
    trackAnalyticsEvent("first_settlement_checklist_abandoned", {
      last_step_key: expandedStep || "unknown",
      incomplete_steps_count: incompleteCount,
    });
  };

  if (isDismissed) {
    return (
      <div className="flex justify-end mb-2">
        <button
          type="button"
          onClick={() => setIsDismissed(false)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1 text-xs font-semibold text-[#0F766E] hover:bg-teal-100 transition-colors"
        >
          <Sparkles size={13} />
          Show settlement checklist ({completedCount}/7 ready)
        </button>
      </div>
    );
  }

  return (
    <div
      role="region"
      aria-label="First-settlement checklist"
      className={`rounded-2xl border border-neutral-200 bg-white p-4 shadow-sm text-[#0F0F14] ${className}`}
    >
      {/* Header */}
      <div className="flex items-start justify-between border-b border-neutral-100 pb-3">
        <div className="flex items-center gap-2.5">
          <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-teal-50 text-[#0F766E]">
            <Sparkles size={16} />
          </span>
          <div>
            <h3 className="text-sm font-bold text-neutral-900">First-Settlement Checklist</h3>
            <p className="text-xs text-neutral-500">
              Verify the 7 essential steps before submitting a payment.
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span
            className={`rounded-full px-2.5 py-0.5 text-[11px] font-bold ${
              completedCount === 7
                ? "bg-teal-100 text-[#0F766E]"
                : hasIncompleteSetup
                ? "bg-amber-100 text-amber-800"
                : "bg-neutral-100 text-neutral-700"
            }`}
          >
            {completedCount}/7 Ready
          </span>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss first-settlement checklist"
            className="text-xs font-medium text-neutral-400 hover:text-neutral-700 p-1"
          >
            Hide
          </button>
        </div>
      </div>

      {/* Proactive Incomplete Setup Alert */}
      {hasIncompleteSetup && (
        <div
          role="alert"
          className="my-3 flex items-start gap-2.5 rounded-xl border border-amber-200 bg-amber-50/80 p-3 text-xs text-amber-900"
        >
          <ShieldAlert size={16} className="shrink-0 text-amber-600 mt-0.5" />
          <div className="flex-1 leading-relaxed">
            <span className="font-bold">Incomplete setup detected: </span>
            Resolve wallet, network, or reserve readiness before attempting settlement to prevent transaction rejection.
          </div>
        </div>
      )}

      {/* Step items list */}
      <div className="mt-3 space-y-1.5" role="list">
        {steps.map((step) => {
          const isExpanded = expandedStep === step.key;
          const StepIcon = step.icon;

          return (
            <div
              key={step.key}
              role="listitem"
              className={`rounded-xl border transition-all ${
                isExpanded
                  ? "border-teal-200 bg-teal-50/30"
                  : "border-neutral-100 hover:border-neutral-200 bg-neutral-50/40"
              }`}
            >
              <button
                type="button"
                onClick={() => toggleStep(step.key)}
                aria-expanded={isExpanded}
                className="flex w-full items-center justify-between p-2.5 text-left focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] rounded-xl"
              >
                <div className="flex items-center gap-2.5 min-w-0">
                  <span
                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-lg ${
                      step.status === "complete"
                        ? "bg-teal-100 text-[#0F766E]"
                        : step.status === "action_required"
                        ? "bg-amber-100 text-amber-700"
                        : "bg-neutral-200 text-neutral-500"
                    }`}
                  >
                    <StepIcon size={14} />
                  </span>
                  <span className="text-xs font-semibold text-neutral-900 truncate">
                    {step.title}
                  </span>
                </div>

                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      step.status === "complete"
                        ? "bg-teal-100 text-[#0F766E]"
                        : step.status === "action_required"
                        ? "bg-amber-100 text-amber-800"
                        : step.status === "ready"
                        ? "bg-blue-100 text-blue-800"
                        : "bg-neutral-100 text-neutral-500"
                    }`}
                  >
                    {step.status === "complete"
                      ? "Cleared"
                      : step.status === "action_required"
                      ? "Action Needed"
                      : step.status === "ready"
                      ? "Ready"
                      : "Pending"}
                  </span>
                  {isExpanded ? (
                    <ChevronUp size={14} className="text-neutral-400" />
                  ) : (
                    <ChevronDown size={14} className="text-neutral-400" />
                  )}
                </div>
              </button>

              {isExpanded && (
                <div className="border-t border-neutral-100 px-3 py-2.5 text-xs text-neutral-600 space-y-2">
                  <p className="leading-relaxed">{step.plainCopy}</p>
                  <p className="font-medium text-neutral-800 bg-white/70 p-2 rounded-lg border border-neutral-200/60">
                    Status: {step.detail}
                  </p>

                  <div className="flex items-center justify-between pt-1">
                    <Link
                      href={`/support?topic=${encodeURIComponent(step.helpTopic)}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 font-semibold text-[#0F766E] hover:underline"
                    >
                      <HelpCircle size={12} />
                      {step.helpTitle}
                      <ExternalLink size={10} />
                    </Link>

                    {step.key === "wallet_connection" && !walletConnected && (
                      <button
                        type="button"
                        onClick={connect}
                        className="rounded-lg bg-[#0F766E] px-2.5 py-1 text-[11px] font-bold text-white hover:bg-[#115E59]"
                      >
                        Connect Wallet
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
