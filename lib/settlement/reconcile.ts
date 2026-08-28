/**
 * lib/settlement/reconcile.ts
 *
 * The reconciliation engine: converges Supabase app state to on-chain reality.
 *
 * Invariants:
 * 1. A payment that lands on Horizon is eventually reflected in app state,
 *    regardless of which client observes it or whether the originating browser
 *    ever returns.
 * 2. On-chain state (Horizon transactions & Soroban contract events) is strictly
 *    authoritative over Supabase.
 * 3. Recovery requires no localStorage: any client on any fresh device converges
 *    to the correct state upon viewing the trip/expense.
 * 4. Reconciliation is idempotent: repeated runs produce no duplicate side-effects.
 */

import { type SettlementIntent, markIntentRecorded, markIntentFailed } from "@/lib/settlement/intent";
import {
  fetchActiveSettlementIntents,
  markSharePaidRow,
  type DatabaseError,
} from "@/lib/supabase/queries";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { recordPaymentOnChain, checkIsPaid } from "@/lib/stellar/contract";
import { CONTRACT_ID } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";
import type { ContractPaymentEvent } from "@/types/contract";
import type { StellarStarClient } from "@/lib/supabase/client";

export interface ReconcileIntentResult {
  intentId: string;
  reconciled: boolean;
  onChain: boolean;
  status: SettlementIntent["status"];
  message?: string;
}

/**
 * Reconciles a single in-flight or partial settlement intent against Horizon and Soroban.
 *
 * If a browser crashed after Horizon submission, this repairs the missing Soroban
 * record and Supabase share state.
 */
export async function reconcileSettlementIntent(
  intent: SettlementIntent,
  client?: StellarStarClient,
): Promise<ReconcileIntentResult> {
  // If already fully recorded, reconciliation is a clean no-op (Invariant 6).
  if (intent.status === "recorded" && intent.onChain) {
    return {
      intentId: intent.id,
      reconciled: true,
      onChain: true,
      status: "recorded",
    };
  }

  // If no txHash exists yet
  if (!intent.txHash) {
    const isExpired = new Date(intent.expiresAt).getTime() <= Date.now();
    if (isExpired) {
      await markIntentFailed(intent.id, "Intent expired without submission.", client);
      return {
        intentId: intent.id,
        reconciled: true,
        onChain: false,
        status: "failed",
        message: "Settlement intent expired without transaction submission.",
      };
    }
    return {
      intentId: intent.id,
      reconciled: false,
      onChain: false,
      status: intent.status,
      message: "Settlement is still in progress in wallet.",
    };
  }

  // 1. Check Horizon: Did the transaction move value on the Stellar ledger?
  let verifiedPayment;
  try {
    verifiedPayment = await verifyPaymentByHash(intent.txHash);
  } catch (err) {
    // If Horizon cannot find the transaction or verification fails
    const message = err instanceof Error ? err.message : "Horizon verification failed.";
    return {
      intentId: intent.id,
      reconciled: false,
      onChain: false,
      status: intent.status,
      message,
    };
  }

  // 2. Horizon confirmed the transaction! Ensure contract is recorded if configured.
  let onChain = intent.onChain;
  let ledger = verifiedPayment.ledger;

  if (CONTRACT_ID && !onChain && intent.tripId) {
    try {
      // Check if already recorded on Soroban contract
      const alreadyOnChain = await checkIsPaid(
        intent.memberWallet,
        intent.expenseId,
        intent.memberWallet,
      );

      if (alreadyOnChain.paid) {
        onChain = true;
      } else {
        // Attempt contract recording
        const attested = await fetchAttestation({
          tripId: intent.tripId,
          expenseId: intent.expenseId,
          payerPublicKey: intent.payerWallet,
          memberPublicKey: intent.memberWallet,
          amountXlm: intent.amount,
          txHash: intent.txHash,
        });

        if (attested.ok) {
          const contractRes = await recordPaymentOnChain({
            memberPublicKey: intent.memberWallet,
            tripId: intent.tripId,
            expenseId: intent.expenseId,
            payerPublicKey: intent.payerWallet,
            amountXlm: intent.amount,
            txHash: intent.txHash,
            attestation: attested.attestation,
          });

          if (contractRes.success) {
            onChain = true;
            if (contractRes.ledger) ledger = contractRes.ledger;
          }
        }
      }
    } catch {
      // Non-fatal: onChain remains false, but financial reality (Horizon payment) is authoritative
    }
  }

  // 3. Mark the share paid in Supabase (atomically via markSharePaidRow)
  try {
    await markSharePaidRow(intent.expenseId, intent.memberId, intent.txHash, client);
  } catch (err) {
    console.warn("[reconcile] markSharePaidRow warning:", err);
  }

  // 4. Mark intent recorded
  await markIntentRecorded(intent.id, ledger, onChain, client);

  return {
    intentId: intent.id,
    reconciled: true,
    onChain,
    status: "recorded",
  };
}

/**
 * Reconciles all pending settlement intents for a wallet from Supabase.
 * Works across any device without requiring localStorage (Invariant 5).
 */
export async function reconcilePendingIntentsForWallet(
  walletAddress: string,
  client?: StellarStarClient,
): Promise<ReconcileIntentResult[]> {
  const activeIntents = await fetchActiveSettlementIntents(walletAddress, client);
  const results: ReconcileIntentResult[] = [];

  for (const intent of activeIntents) {
    try {
      const result = await reconcileSettlementIntent(intent, client);
      results.push(result);
    } catch (err) {
      console.warn(`[reconcile] Error reconciling intent ${intent.id}:`, err);
    }
  }

  return results;
}

export interface ReconcileTripResult {
  reconciledCount: number;
  repairedExpenseIds: string[];
}

/**
 * Reconciles a trip's expense shares against on-chain contract payment events.
 *
 * If a payment exists on Soroban / Horizon but Supabase shares show unpaid,
 * this repairs Supabase state to believe the chain (Invariant 1 & 2).
 */
export async function reconcileTripWithChainState(
  tripId: string,
  expenses: Expense[],
  onChainEvents: ContractPaymentEvent[],
  client?: StellarStarClient,
): Promise<ReconcileTripResult> {
  let reconciledCount = 0;
  const repairedExpenseIds: string[] = [];

  if (!tripId || onChainEvents.length === 0 || expenses.length === 0) {
    return { reconciledCount, repairedExpenseIds };
  }

  for (const event of onChainEvents) {
    if (event.tripId !== tripId) continue;

    const expense = expenses.find((e) => e.id === event.expenseId);
    if (!expense) continue;

    // Find the share that corresponds to this on-chain event's debtor member
    const memberLower = event.member.toLowerCase();
    const share = expense.shares.find(
      (s) =>
        !s.paid &&
        ((s.walletAddress && s.walletAddress.toLowerCase() === memberLower) ||
          expense.members.find((m) => m.id === s.memberId)?.walletAddress?.toLowerCase() ===
            memberLower),
    );

    if (share && !share.paid) {
      try {
        await markSharePaidRow(expense.id, share.memberId, event.txHash, client);
        reconciledCount++;
        repairedExpenseIds.push(expense.id);
      } catch (err) {
        console.warn(`[reconcile] Failed to repair share for expense ${expense.id}:`, err);
      }
    }
  }

  return { reconciledCount, repairedExpenseIds };
}
