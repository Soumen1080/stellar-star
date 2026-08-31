"use client";

import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, Info, Lock } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { useTrustline } from "@/hooks/useTrustline";
import { formatAssetLabel, type AssetRef } from "@/lib/stellar/assets";
import { type OnboardingNeed, stroopsToXlm } from "@/lib/stellar/accountState";

interface TrustlinePromptProps {
  /** The account adding the trustline. */
  publicKey: string;
  /** The required trustline. */
  asset: AssetRef;
  /** The specific trustline state from describeOnboardingNeed. */
  need: Extract<OnboardingNeed, { kind: `trustline_${string}` }>;
  onComplete?: () => void;
}

export function TrustlinePrompt({
  publicKey,
  asset,
  need,
  onComplete,
}: TrustlinePromptProps) {
  const { phase, error, addTrustline, reset } = useTrustline(asset);
  
  useEffect(() => {
    if (phase === "done") onComplete?.();
  }, [phase, onComplete]);

  const busy = phase === "preparing" || phase === "awaiting_signature" || phase === "submitting";

  const busyLabel: Record<string, string> = {
    preparing: "Preparing transaction…",
    awaiting_signature: "Confirm in your wallet…",
    submitting: "Submitting…",
  };

  if (phase === "done") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-[#2DD4BF]/30 bg-[#2DD4BF]/10 p-4">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[#2DD4BF]" />
        <div>
          <p className="text-sm font-semibold text-[#2DD4BF]">Trustline added</p>
          <p className="text-sm text-white/70">
            You can now receive {formatAssetLabel(asset)}.
          </p>
        </div>
      </div>
    );
  }

  if (phase === "error") {
    return (
      <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-200">Could not add trustline</p>
            <p className="text-sm text-amber-100/80">{error}</p>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="ghost-white" onClick={reset}>
            Dismiss
          </Button>
          <Button onClick={() => addTrustline(publicKey)}>Try again</Button>
        </div>
      </div>
    );
  }

  // 1. Missing Trustline
  if (need.kind === "trustline_missing") {
    return (
      <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-start gap-3">
          <Info size={18} className="mt-0.5 shrink-0 text-white" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-white">
              Add {formatAssetLabel(asset)} to your wallet
            </p>
            <p className="text-sm text-white/60">
              Before you can hold this asset, you must opt in by creating a trustline.
            </p>
          </div>
        </div>

        <div className="flex gap-2.5 rounded-lg border border-white/10 bg-black/20 p-3">
          <Lock size={15} className="mt-0.5 shrink-0 text-white/40" />
          <p className="text-xs text-white/50">
            Adding a trustline requires locking {stroopsToXlm(need.reserveStroops)} XLM in reserve. 
            This XLM remains yours and will be returned if you remove the trustline later.
          </p>
        </div>

        {!need.affordable && (
          <p className="text-xs text-amber-200/80">
            You do not have enough spendable XLM to cover the {stroopsToXlm(need.reserveStroops)} XLM reserve.
            Fund your account first.
          </p>
        )}

        <Button
          onClick={() => addTrustline(publicKey)}
          disabled={busy || !need.affordable}
          className="w-full"
        >
          {busy ? (
            <span className="inline-flex items-center gap-2">
              <Loader2 size={14} className="animate-spin" />
              {busyLabel[phase] ?? "Working…"}
            </span>
          ) : (
            `Add Trustline (Locks ${stroopsToXlm(need.reserveStroops)} XLM)`
          )}
        </Button>
      </div>
    );
  }

  // 2. Unauthorized
  if (need.kind === "trustline_unauthorized") {
    return (
      <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-200">Not authorized</p>
            <p className="text-sm text-amber-100/80">
              Your account has a trustline for {formatAssetLabel(asset)}, but the issuer has not 
              authorized you to hold it. You must contact the asset issuer.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 3. Authorized only to maintain liabilities
  if (need.kind === "trustline_auth_maintain") {
    return (
      <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-200">Cannot receive payments</p>
            <p className="text-sm text-amber-100/80">
              Your account is only authorized to maintain liabilities for {formatAssetLabel(asset)}. 
              You can trade it on the DEX, but you cannot receive direct payments.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 4. Sponsored — not a blocker, but the user should know their reserve is
  // being paid by someone else and what happens if that stops.
  if (need.kind === "trustline_sponsored") {
    return (
      <div className="space-y-3 rounded-xl border border-white/10 bg-white/[0.02] p-4">
        <div className="flex items-start gap-3">
          <Info size={18} className="mt-0.5 shrink-0 text-white/70" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-white">
              {formatAssetLabel(asset)} reserve is sponsored
            </p>
            <p className="text-sm text-white/60">
              You can receive {formatAssetLabel(asset)} today. The{" "}
              {stroopsToXlm(need.reserveStroops)} XLM reserve for this trustline is
              held by{" "}
              <span className="font-mono text-xs text-white/70">
                {need.sponsor.slice(0, 4)}…{need.sponsor.slice(-4)}
              </span>
              , not by you. If they remove the sponsorship, you will need that
              amount in your own balance to keep the trustline.
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 5. At Limit
  if (need.kind === "trustline_at_limit") {
    return (
      <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-200">Trustline Full</p>
            <p className="text-sm text-amber-100/80">
              You cannot receive more {formatAssetLabel(asset)} because your trustline has reached its limit. 
              Increase your trustline limit to receive more.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return null;
}
