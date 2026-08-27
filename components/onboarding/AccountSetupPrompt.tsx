"use client";

/**
 * What a user with no Stellar account sees.
 *
 * This replaces the dead end. Previously an unfunded account produced a Horizon
 * 404 that surfaced as "something failed" and stopped — for exactly the person
 * the app most needs to onboard.
 *
 * Every state below offers a next step, including the ones the app cannot
 * solve. When sponsorship is exhausted or the inviter is ineligible, the user
 * is told what *they* can still do rather than being shown a wall.
 */

import React, { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { Button } from "@/components/ui/Button";
import {
  fetchSponsorCapacity,
  useAccountOnboarding,
  type OnboardingBlocker,
} from "@/hooks/useAccountOnboarding";
import { formatAssetLabel, NATIVE_ASSET, type AssetRef } from "@/lib/stellar/assets";
import { stroopsToXlm } from "@/lib/stellar/accountState";

interface AccountSetupPromptProps {
  /** The account being onboarded — normally the connected wallet. */
  publicKey: string;
  /** The asset they need to be able to receive. */
  asset?: AssetRef;
  onComplete?: () => void;
}

/**
 * What the user can do about each blocker.
 *
 * The distinction that matters: a blocker on the *sponsor's* side still leaves
 * self-funding open, and saying so is the difference between a wall and a
 * detour.
 */
function blockerGuidance(blocker: OnboardingBlocker): { title: string; body: string } {
  switch (blocker) {
    case "sponsor_exhausted":
      return {
        title: "Sponsored setup is at capacity",
        body:
          "We are temporarily out of sponsorship capacity. You can still join by funding " +
          "your account yourself — send at least 1.5 XLM to the address below from any " +
          "wallet or exchange. Capacity also frees up as dormant accounts are released.",
      };
    case "sponsor_unconfigured":
      return {
        title: "Sponsored setup is unavailable",
        body:
          "This deployment does not offer sponsored account creation. Send at least " +
          "1.5 XLM to the address below to activate your account.",
      };
    case "inviter_unfunded":
    case "inviter_below_threshold":
      return {
        title: "Your inviter cannot sponsor yet",
        body:
          "The person who invited you needs a funded account before they can sponsor " +
          "others. Ask another group member to invite you, or fund your account directly.",
      };
    case "inviter_quota_exceeded":
      return {
        title: "Your inviter has reached their limit",
        body:
          "They have already sponsored the maximum number of accounts. Ask another group " +
          "member to send the invite instead.",
      };
    case "inviter_cooldown":
      return {
        title: "Try again shortly",
        body:
          "Your inviter sponsored someone very recently. Wait a little and try again, or " +
          "ask another group member.",
      };
    case "already_sponsored":
      return {
        title: "Already sponsored",
        body: "This account has already been sponsored. Try refreshing.",
      };
    case "horizon_unavailable":
      return {
        title: "Could not reach the network",
        body: "This is usually temporary — try again in a moment.",
      };
    default:
      return {
        title: "Setup did not complete",
        body: "Something went wrong. You can try again, or fund your account directly.",
      };
  }
}

export function AccountSetupPrompt({
  publicKey,
  asset = NATIVE_ASSET,
  onComplete,
}: AccountSetupPromptProps) {
  const { state, checkAccount, requestSponsorship, reset } = useAccountOnboarding(asset);
  const [capacityAvailable, setCapacityAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    checkAccount(publicKey);
  }, [publicKey, checkAccount]);

  useEffect(() => {
    fetchSponsorCapacity().then((c) => setCapacityAvailable(c ? c.available : null));
  }, []);

  useEffect(() => {
    if (state.phase === "done") onComplete?.();
  }, [state.phase, onComplete]);

  const busy = ["checking", "preparing", "awaiting_signature", "submitting"].includes(
    state.phase,
  );

  const busyLabel: Record<string, string> = {
    checking: "Checking your account…",
    preparing: "Preparing sponsorship…",
    awaiting_signature: "Confirm in your wallet…",
    submitting: "Activating your account…",
  };

  // Nothing to do — either already usable, or just finished.
  if (state.phase === "done" || state.need?.kind === "none") {
    return (
      <div className="flex items-start gap-3 rounded-xl border border-[#2DD4BF]/30 bg-[#2DD4BF]/10 p-4">
        <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-[#2DD4BF]" />
        <div>
          <p className="text-sm font-semibold text-[#2DD4BF]">Account ready</p>
          <p className="text-sm text-white/70">
            {state.message ?? `You can receive ${formatAssetLabel(asset)} and settle expenses.`}
          </p>
        </div>
      </div>
    );
  }

  if (state.phase === "error" && state.blocker) {
    const guidance = blockerGuidance(state.blocker);
    return (
      <div className="space-y-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
        <div className="flex items-start gap-3">
          <AlertTriangle size={18} className="mt-0.5 shrink-0 text-amber-400" />
          <div className="space-y-1">
            <p className="text-sm font-semibold text-amber-200">{guidance.title}</p>
            <p className="text-sm text-amber-100/80">{guidance.body}</p>
            {state.message && (
              <p className="text-xs text-amber-100/50">{state.message}</p>
            )}
          </div>
        </div>

        {/* Self-funding stays available whenever the blocker is on our side. */}
        <div className="rounded-lg bg-black/20 p-3">
          <p className="text-xs uppercase tracking-wide text-white/40">Your address</p>
          <p className="break-all font-mono text-xs text-white/80">{publicKey}</p>
        </div>

        <div className="flex justify-end gap-2">
          <Button variant="ghost-white" onClick={reset}>
            Dismiss
          </Button>
          <Button onClick={() => checkAccount(publicKey)}>I&apos;ve funded it — recheck</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 rounded-xl border border-white/10 bg-white/[0.02] p-4">
      <div className="flex items-start gap-3">
        <Wallet size={18} className="mt-0.5 shrink-0 text-[#2DD4BF]" />
        <div className="space-y-1">
          <p className="text-sm font-semibold text-white">
            {state.need?.kind === "trustline"
              ? `Allow ${formatAssetLabel(asset)} on your account`
              : "Activate your Stellar account"}
          </p>
          <p className="text-sm text-white/60">
            {state.need?.kind === "trustline"
              ? `Your account exists but cannot hold ${formatAssetLabel(asset)} yet. Adding it ` +
                `requires ${stroopsToXlm(state.need.reserveStroops)} XLM held in reserve.`
              : "Stellar accounts need a small reserve before they exist on the network. " +
                "We can cover it for you — the reserve stays yours to use, and you keep " +
                "full control of your keys."}
          </p>
        </div>
      </div>

      {state.need?.kind === "account_creation" && (
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">Reserve required</dt>
            <dd className="text-white/80">
              {stroopsToXlm(state.need.reserveStroops)} XLM
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-white/50">Cost to you</dt>
            <dd className="font-semibold text-[#2DD4BF]">Nothing</dd>
          </div>
        </dl>
      )}

      {/* Invariant 4, said plainly — the thing a cautious user needs to hear. */}
      <div className="flex gap-2.5 rounded-lg border border-white/10 bg-black/20 p-3">
        <ShieldCheck size={15} className="mt-0.5 shrink-0 text-white/40" />
        <p className="text-xs text-white/50">
          You sign this yourself and your keys never leave your wallet. The sponsored
          reserve can be released later — by you at any time, or by us if the account stays
          unused — and releasing it never touches your own funds.
        </p>
      </div>

      {capacityAvailable === false && (
        <p className="text-xs text-amber-200/80">
          Sponsored setup is currently at capacity. You can still fund your account
          directly with 1.5 XLM.
        </p>
      )}

      <Button
        onClick={() => requestSponsorship(publicKey)}
        disabled={busy || capacityAvailable === false}
        className="w-full"
      >
        {busy ? (
          <span className="inline-flex items-center gap-2">
            <Loader2 size={14} className="animate-spin" />
            {busyLabel[state.phase] ?? "Working…"}
          </span>
        ) : (
          "Activate my account"
        )}
      </Button>
    </div>
  );
}
