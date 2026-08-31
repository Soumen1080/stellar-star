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
import { recordPaymentOnChain, checkIsPaid, getContractPayments } from "@/lib/stellar/contract";
import { fetchContractEvents, buildPaymentEventKey } from "@/lib/stellar/events";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { Money } from "@/lib/money";
import {
  assetKey,
  parseAssetKey,
  tryParseAssetKey,
  NATIVE_ASSET_KEY,
} from "@/lib/stellar/assets";
import type { Expense } from "@/types/expense";
import type { ContractPaymentEvent, ContractPaymentRecord } from "@/types/contract";
import type { StellarStarClient } from "@/lib/supabase/client";

function normalizeAssetKey(assetStr?: string | null): string {
  if (!assetStr) return NATIVE_ASSET_KEY;
  const trimmed = assetStr.trim();
  if (trimmed === "" || trimmed === "native" || trimmed.toUpperCase() === "XLM") {
    return NATIVE_ASSET_KEY;
  }
  const parsed = tryParseAssetKey(trimmed);
  return parsed ? assetKey(parsed) : trimmed;
}

function parseAmountToStroops(amountStr: string | number): bigint {
  try {
    return Money.parse(String(amountStr)).toStroops();
  } catch {
    const num = Number(amountStr);
    return isNaN(num) ? 0n : BigInt(Math.round(num * 10_000_000));
  }
}

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

export type PaymentRecordOrEvent =
  | ContractPaymentEvent
  | ContractPaymentRecord
  | {
      tripId: string;
      expenseId: string;
      member: string;
      amountStroops: bigint | string | number;
      asset?: string;
      txHash: string;
    };

/**
 * Reconciles a trip's expense shares against on-chain contract payment records / events.
 *
 * Invariant 1: Matching is exact on (tripId, expenseId, member wallet, amount in stroops, asset).
 * Invariant 2: Deduplication and reconciliation are idempotent and order-independent.
 */
export async function reconcileTripWithChainState(
  tripId: string,
  expenses: Expense[],
  onChainPayments: PaymentRecordOrEvent[],
  client?: StellarStarClient,
): Promise<ReconcileTripResult> {
  let reconciledCount = 0;
  const repairedExpenseIds: string[] = [];

  if (!tripId || onChainPayments.length === 0 || expenses.length === 0) {
    return { reconciledCount, repairedExpenseIds };
  }

  for (const payment of onChainPayments) {
    if (payment.tripId && payment.tripId !== tripId) continue;

    const expense = expenses.find((e) => e.id === payment.expenseId);
    if (!expense) continue;

    const expenseAsset = normalizeAssetKey(expense.currency);
    const paymentAsset = normalizeAssetKey(payment.asset);
    if (expenseAsset !== paymentAsset) {
      // Invariant 1: Never match payments across different assets (e.g. 10 USDC vs 10 XLM)
      continue;
    }

    const paymentAmountStroops = typeof payment.amountStroops === "bigint"
      ? payment.amountStroops
      : BigInt(payment.amountStroops ?? 0);

    const memberLower = (payment.member ?? "").trim().toLowerCase();
    const share = expense.shares.find((s) => {
      if (s.paid) return false;
      const shareWallet = (
        s.walletAddress ||
        expense.members.find((m) => m.id === s.memberId)?.walletAddress ||
        ""
      ).trim().toLowerCase();

      if (shareWallet !== memberLower) return false;

      const shareStroops = parseAmountToStroops(s.amount);
      return shareStroops === paymentAmountStroops;
    });

    if (share && !share.paid) {
      try {
        await markSharePaidRow(expense.id, share.memberId, payment.txHash, client);
        reconciledCount++;
        if (!repairedExpenseIds.includes(expense.id)) {
          repairedExpenseIds.push(expense.id);
        }
      } catch (err) {
        console.warn(`[reconcile] Failed to repair share for expense ${expense.id}:`, err);
      }
    }
  }

  return { reconciledCount, repairedExpenseIds };
}

export interface ReconcileTripFromChainResult extends ReconcileTripResult {
  payments: ContractPaymentRecord[];
  events: ContractPaymentEvent[];
  source: "state" | "events" | "merged" | "none";
}

/**
 * Reconciles a trip completely against both durable contract state (`get_payments`)
 * and live RPC streaming events (`fetchContractEvents`).
 *
 * Solves the RPC retention window problem: trips older than ~24 hours reconcile
 * reliably from contract state even if event history was pruned.
 */
export async function reconcileTripFromChain(
  tripId: string,
  expenses: Expense[],
  callerPublicKey?: string,
  client?: StellarStarClient,
): Promise<ReconcileTripFromChainResult> {
  let payments: ContractPaymentRecord[] = [];
  let events: ContractPaymentEvent[] = [];

  if (CONTRACT_ID && tripId) {
    // 1. Read durable contract storage (survives event retention expiry)
    try {
      const stateResult = await getContractPayments(callerPublicKey || "", tripId);
      if (stateResult.success && stateResult.payments.length > 0) {
        payments = stateResult.payments;
      }
    } catch (err) {
      console.warn("[reconcile] Contract state read error:", err);
    }

    // 2. Read live RPC event stream (real-time notifications)
    try {
      const eventsResult = await fetchContractEvents(0, tripId);
      if (eventsResult.events.length > 0) {
        events = eventsResult.events;
      }
    } catch (err) {
      console.warn("[reconcile] Contract events fetch error:", err);
    }
  }

  // Deduplicate union using buildPaymentEventKey
  const combinedMap = new Map<string, PaymentRecordOrEvent>();

  for (const p of payments) {
    const key = buildPaymentEventKey({
      tripId: p.tripId,
      expenseId: p.expenseId,
      member: p.member,
      amountStroops: p.amountStroops,
      asset: p.asset,
    });
    combinedMap.set(key, p);
  }

  for (const e of events) {
    const key = buildPaymentEventKey({
      tripId: e.tripId,
      expenseId: e.expenseId,
      member: e.member,
      amountStroops: e.amountStroops,
      asset: e.asset,
    });
    if (!combinedMap.has(key)) {
      combinedMap.set(key, e);
    }
  }

  const allPayments = Array.from(combinedMap.values());
  const { reconciledCount, repairedExpenseIds } = await reconcileTripWithChainState(
    tripId,
    expenses,
    allPayments,
    client,
  );

  let source: "state" | "events" | "merged" | "none" = "none";
  if (payments.length > 0 && events.length > 0) source = "merged";
  else if (payments.length > 0) source = "state";
  else if (events.length > 0) source = "events";

  return {
    reconciledCount,
    repairedExpenseIds,
    payments,
    events,
    source,
  };
}
