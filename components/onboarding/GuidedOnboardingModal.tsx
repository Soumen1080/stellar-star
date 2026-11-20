"use client";

import React, { useState, useEffect, useCallback, useId } from "react";
import {
  X,
  ChevronRight,
  ChevronLeft,
  CheckCircle2,
  HelpCircle,
  ExternalLink,
  ShieldCheck,
  Compass,
  Wallet,
  Coins,
  Users,
  Eye,
  Check,
  type LucideIcon,
} from "lucide-react";
import Link from "next/link";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

export type OnboardingMode = "create" | "join" | "view";

export interface OnboardingStep {
  id: string;
  title: string;
  description: string;
  helpTopic: string;
  helpLabel: string;
  icon: LucideIcon;
  actions?: Array<{
    label: string;
    onClick?: () => void;
    href?: string;
    primary?: boolean;
  }>;
}

const ONBOARDING_FLOWS: Record<OnboardingMode, { title: string; subtitle: string; steps: OnboardingStep[] }> = {
  create: {
    title: "Trip Creator Quickstart",
    subtitle: "Get your group trip set up in 3 simple steps. You can skip this anytime.",
    steps: [
      {
        id: "create_wallet",
        title: "Connect your wallet",
        description:
          "Connect a Stellar wallet (like Freighter) to organize expenses and receive settlements securely.",
        helpTopic: "wallet-setup",
        helpLabel: "How to set up a wallet",
        icon: Wallet,
      },
      {
        id: "create_details",
        title: "Name your trip & choose currency",
        description:
          "Pick a name for your adventure and a primary settlement currency (such as USDC or XLM).",
        helpTopic: "trip-basics",
        helpLabel: "Understanding trip currencies",
        icon: Coins,
      },
      {
        id: "create_invite",
        title: "Invite members & add expenses",
        description:
          "Share a private invite link with friends. Anyone with the link can view or join according to your trip settings.",
        helpTopic: "inviting-members",
        helpLabel: "Invites and member roles",
        icon: Users,
      },
    ],
  },
  join: {
    title: "Welcome to the Trip!",
    subtitle: "Here is how to get ready to split expenses and settle balances.",
    steps: [
      {
        id: "join_wallet",
        title: "Connect your wallet",
        description:
          "Connect your wallet to claim your spot in the trip and link your payments to your account.",
        helpTopic: "wallet-setup",
        helpLabel: "Wallet connection guide",
        icon: Wallet,
      },
      {
        id: "join_network",
        title: "Verify network & asset readiness",
        description:
          "Make sure your wallet is on the same network (Testnet or Mainnet) and has trustlines enabled if settling in USDC.",
        helpTopic: "trustlines",
        helpLabel: "What is an asset trustline?",
        icon: ShieldCheck,
      },
      {
        id: "join_settle",
        title: "View expenses & settle shares",
        description:
          "Track who paid for what. When you owe a balance, you can pay directly on-chain with zero hidden fees.",
        helpTopic: "settlement",
        helpLabel: "How on-chain settlement works",
        icon: CheckCircle2,
      },
    ],
  },
  view: {
    title: "Exploring this Trip",
    subtitle: "You have view-only access. Here is what you can see and do.",
    steps: [
      {
        id: "view_transparency",
        title: "Explore trip breakdown",
        description:
          "All expenses, shared categories, and current group balances are visible transparently below.",
        helpTopic: "trip-view",
        helpLabel: "Understanding trip balances",
        icon: Eye,
      },
      {
        id: "view_connect",
        title: "Connect wallet to join",
        description:
          "If you want to record an expense or settle a share, connect your wallet to request member access.",
        helpTopic: "member-roles",
        helpLabel: "Roles and permissions",
        icon: Wallet,
      },
      {
        id: "view_support",
        title: "Need help or dispute an item?",
        description:
          "Our support console lets you verify transactions or request corrections without exposing private data.",
        helpTopic: "disputes",
        helpLabel: "Resolving expense questions",
        icon: HelpCircle,
      },
    ],
  },
};

interface GuidedOnboardingModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode?: OnboardingMode;
  onComplete?: () => void;
}

export function GuidedOnboardingModal({
  isOpen,
  onClose,
  mode = "view",
  onComplete,
}: GuidedOnboardingModalProps) {
  const [currentStepIndex, setCurrentStepIndex] = useState(0);
  const startTime = React.useRef(Date.now());
  const flow = ONBOARDING_FLOWS[mode] || ONBOARDING_FLOWS.view;
  const steps = flow.steps;
  const currentStep = steps[currentStepIndex] || steps[0];

  const titleId = useId();
  const descId = useId();

  // Track initial start
  useEffect(() => {
    if (isOpen) {
      startTime.current = Date.now();
      trackAnalyticsEvent("onboarding_started", {
        step: currentStepIndex + 1,
        mode,
      });
    }
  }, [isOpen, mode, currentStepIndex]);

  const handleSkip = useCallback(() => {
    trackAnalyticsEvent("onboarding_abandoned", {
      mode,
      last_step_index: currentStepIndex + 1,
    });
    try {
      localStorage.setItem(`stellar_star_onboarding_${mode}_dismissed`, "true");
    } catch {
      // Storage unavailable
    }
    onClose();
  }, [mode, currentStepIndex, onClose]);

  const goToStep = useCallback(
    (index: number) => {
      if (index > currentStepIndex) {
        trackAnalyticsEvent("onboarding_step_completed", {
          mode,
          step_index: currentStepIndex + 1,
          step_name: currentStep.id,
        });
      }
      setCurrentStepIndex(index);
    },
    [currentStepIndex, currentStep.id, mode]
  );

  // Handle keyboard navigation (Escape, ArrowRight, ArrowLeft)
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        handleSkip();
      } else if (e.key === "ArrowRight") {
        if (currentStepIndex < steps.length - 1) {
          goToStep(currentStepIndex + 1);
        }
      } else if (e.key === "ArrowLeft") {
        if (currentStepIndex > 0) {
          goToStep(currentStepIndex - 1);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, currentStepIndex, steps.length, goToStep, handleSkip]);

  const handleNext = () => {
    if (currentStepIndex < steps.length - 1) {
      goToStep(currentStepIndex + 1);
    } else {
      handleComplete();
    }
  };

  const handleComplete = () => {
    trackAnalyticsEvent("onboarding_step_completed", {
      mode,
      step_index: currentStepIndex + 1,
      step_name: currentStep.id,
    });
    trackAnalyticsEvent("onboarding_completed", {
      step_count: steps.length,
      duration_ms: Date.now() - startTime.current,
      mode,
    });
    try {
      localStorage.setItem(`stellar_star_onboarding_${mode}_dismissed`, "true");
    } catch {
      // Storage unavailable
    }
    onComplete?.();
    onClose();
  };

  if (!isOpen) return null;

  const StepIcon = currentStep.icon;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descId}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200"
    >
      <div className="relative w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl border border-neutral-100 text-[#0F0F14] focus:outline-none">
        {/* Top Header */}
        <div className="flex items-center justify-between border-b border-neutral-100 pb-4">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#2DD4BF]/20 text-[#0F766E]">
              <Compass size={18} />
            </span>
            <div>
              <h2 id={titleId} className="text-base font-bold text-neutral-900">
                {flow.title}
              </h2>
              <p className="text-xs text-neutral-500">
                Step {currentStepIndex + 1} of {steps.length}
              </p>
            </div>
          </div>
          <button
            onClick={handleSkip}
            aria-label="Skip onboarding guide"
            className="rounded-lg p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 focus:ring-2 focus:ring-[#2DD4BF] focus:outline-none transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        {/* Step Progress indicators */}
        <div className="mt-4 flex gap-1.5" role="tablist" aria-label="Onboarding steps">
          {steps.map((s, idx) => (
            <button
              key={s.id}
              role="tab"
              aria-selected={idx === currentStepIndex}
              aria-label={`Step ${idx + 1}: ${s.title}`}
              onClick={() => goToStep(idx)}
              className={`h-1.5 flex-1 rounded-full transition-all focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] ${
                idx === currentStepIndex
                  ? "bg-[#0F766E]"
                  : idx < currentStepIndex
                  ? "bg-[#2DD4BF]"
                  : "bg-neutral-200"
              }`}
            />
          ))}
        </div>

        {/* Step Content */}
        <div className="my-6">
          <div className="flex items-start gap-3">
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-teal-50 text-[#0F766E] border border-teal-100">
              <StepIcon size={20} />
            </span>
            <div className="flex-1">
              <h3 className="text-base font-semibold text-neutral-900">{currentStep.title}</h3>
              <p id={descId} className="mt-1.5 text-sm leading-relaxed text-neutral-600">
                {currentStep.description}
              </p>
            </div>
          </div>

          {/* Contextual Support Article Link (Safe, no leaked trip data) */}
          <div className="mt-4 rounded-xl bg-neutral-50 p-3 border border-neutral-200/60">
            <div className="flex items-center justify-between text-xs text-neutral-600">
              <span className="flex items-center gap-1.5 font-medium">
                <HelpCircle size={14} className="text-[#0F766E]" />
                {currentStep.helpLabel}
              </span>
              <Link
                href={`/support?topic=${encodeURIComponent(currentStep.helpTopic)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 font-semibold text-[#0F766E] hover:underline focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] rounded"
              >
                Read guide
                <ExternalLink size={12} />
              </Link>
            </div>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center justify-between border-t border-neutral-100 pt-4">
          <button
            type="button"
            onClick={handleSkip}
            className="text-xs font-medium text-neutral-500 hover:text-neutral-800 focus:outline-none focus:ring-2 focus:ring-[#2DD4BF] rounded px-2 py-1"
          >
            Skip for now
          </button>

          <div className="flex items-center gap-2">
            {currentStepIndex > 0 && (
              <button
                type="button"
                onClick={() => goToStep(currentStepIndex - 1)}
                className="inline-flex items-center gap-1 rounded-xl px-3 py-1.5 text-xs font-semibold text-neutral-700 hover:bg-neutral-100 focus:ring-2 focus:ring-[#2DD4BF] focus:outline-none transition-colors"
              >
                <ChevronLeft size={14} />
                Back
              </button>
            )}

            <button
              type="button"
              onClick={handleNext}
              className="inline-flex items-center gap-1.5 rounded-xl bg-[#0F766E] px-4 py-2 text-xs font-bold text-white shadow-sm hover:bg-[#115E59] focus:ring-2 focus:ring-[#2DD4BF] focus:outline-none transition-colors"
            >
              {currentStepIndex < steps.length - 1 ? (
                <>
                  Next
                  <ChevronRight size={14} />
                </>
              ) : (
                <>
                  Finish
                  <Check size={14} />
                </>
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
