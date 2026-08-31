"use client";

/**
 * Onboarding an account that does not exist yet.
 *
 * The flow, and why it has this shape:
 *
 *  1. Read the invitee's account state. A Horizon 404 is `unfunded`, a state
 *     with a next step — not an error.
 *  2. Ask the server to prepare a sponsored creation. It returns a
 *     *partially signed* transaction, sponsor's half only.
 *  3. The invitee signs in their own wallet and submits.
 *
 * Step 3 is why the server never holds the invitee's key: the transaction is
 * inert without their signature, so nobody can create an account they do not
 * control (invariant 4).
 */

import { useCallback, useState } from "react";
import { getAccountState, type AccountState, type OnboardingNeed } from "@/lib/stellar/accountState";
import { describeOnboardingNeed, isBlockingNeed } from "@/lib/stellar/accountState";
import { assetKey, NATIVE_ASSET, type AssetRef } from "@/lib/stellar/assets";
import { signXDR } from "@/lib/freighter";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { getAccessToken } from "@/lib/supabase/session";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

export type OnboardingPhase =
  | "idle"
  | "checking"
  | "preparing"
  | "awaiting_signature"
  | "submitting"
  | "done"
  | "error";

/** Why sponsorship could not be offered. Each needs different words. */
export type OnboardingBlocker =
  | "sponsor_exhausted"
  | "sponsor_unconfigured"
  | "inviter_unfunded"
  | "inviter_below_threshold"
  | "inviter_quota_exceeded"
  | "inviter_cooldown"
  | "already_sponsored"
  | "horizon_unavailable"
  | "unknown";

export interface OnboardingState {
  phase: OnboardingPhase;
  accountState: AccountState | null;
  need: OnboardingNeed | null;
  blocker: OnboardingBlocker | null;
  message: string | null;
  txHash: string | null;
}

const INITIAL: OnboardingState = {
  phase: "idle",
  accountState: null,
  need: null,
  blocker: null,
  message: null,
  txHash: null,
};

export function useAccountOnboarding(asset: AssetRef = NATIVE_ASSET) {
  const [state, setState] = useState<OnboardingState>(INITIAL);

  const reset = useCallback(() => setState(INITIAL), []);

  /** Reads whether an address can currently receive `asset`. */
  const checkAccount = useCallback(
    async (publicKey: string) => {
      setState((s) => ({ ...s, phase: "checking", blocker: null, message: null }));

      try {
        const accountState = await getAccountState(publicKey);
        const need = describeOnboardingNeed(accountState, asset);

        setState((s) => ({
          ...s,
          // A sponsored trustline is informational, not a blocker: the user can
          // already receive the asset, so the flow is done even though `need`
          // is not "none".
          phase: isBlockingNeed(need) ? "idle" : "done",
          accountState,
          need,
        }));

        return { accountState, need };
      } catch (err) {
        setState((s) => ({
          ...s,
          phase: "error",
          blocker: "horizon_unavailable",
          message:
            err instanceof Error
              ? err.message
              : "Could not check that account. This is a network problem, not a missing account.",
        }));
        return null;
      }
    },
    [asset],
  );

  /**
   * Requests a sponsorship and walks the invitee through signing it.
   *
   * `signerIsInvitee` must be true — the connected wallet has to be the account
   * being created, because it is the only key that can complete the sandwich.
   */
  const requestSponsorship = useCallback(
    async (invitee: string) => {
      setState((s) => ({ ...s, phase: "preparing", blocker: null, message: null }));

      let response: Response;
      try {
        response = await fetch("/api/onboarding/sponsor", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            ...(getAccessToken() ? { Authorization: `Bearer ${getAccessToken()}` } : {}),
          },
          body: JSON.stringify({
            invitee,
            assetKey: assetKey(asset) === "native" ? undefined : assetKey(asset),
          }),
        });
      } catch {
        setState((s) => ({
          ...s,
          phase: "error",
          blocker: "unknown",
          message: "Could not reach the server to prepare the invite.",
        }));
        return false;
      }

      const body = (await response.json().catch(() => ({}))) as {
        xdr?: string;
        error?: string;
        reason?: OnboardingBlocker;
        alreadyFunded?: boolean;
        reclaimableSponsorships?: number;
      };

      if (body.alreadyFunded) {
        setState((s) => ({
          ...s,
          phase: "done",
          message: "That account already exists — no sponsorship needed.",
        }));
        return true;
      }

      if (!response.ok || !body.xdr) {
        setState((s) => ({
          ...s,
          phase: "error",
          blocker: body.reason ?? "unknown",
          message: body.error ?? "Could not prepare the sponsorship.",
        }));
        return false;
      }

      // The invitee's signature completes a transaction that is inert without it.
      setState((s) => ({ ...s, phase: "awaiting_signature" }));

      try {
        const signed = await signXDR(body.xdr, NETWORK_PASSPHRASE);

        setState((s) => ({ ...s, phase: "submitting" }));
        const result = await submitSignedTransaction(signed);

        setState((s) => ({
          ...s,
          phase: "done",
          txHash: result.hash,
          message: "Your account is live. You can now be added to expenses and settle.",
        }));
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Signing failed.";
        const rejected = /reject|denied|cancel/i.test(message);
        setState((s) => ({
          ...s,
          phase: "error",
          blocker: "unknown",
          message: rejected ? "You cancelled the wallet signature." : message,
        }));
        return false;
      }
    },
    [asset],
  );

  return { state, checkAccount, requestSponsorship, reset };
}

/** Sponsorship capacity, so the UI can warn before someone tries and fails. */
export async function fetchSponsorCapacity(): Promise<{
  available: boolean;
  reclaimableSponsorships?: number;
} | null> {
  try {
    const response = await fetch("/api/onboarding/sponsor");
    if (!response.ok) return null;
    return (await response.json()) as { available: boolean; reclaimableSponsorships?: number };
  } catch {
    return null;
  }
}
