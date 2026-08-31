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
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
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

    // The expense's SETTLEMENT asset. Matching on `expense.currency` compared
    // an on-chain asset against a fiat code, so a EUR-entered expense never
    // matched its own native-XLM payment and silently failed to reconcile.
    const expenseAsset = normalizeAssetKey(settlementAssetOf(expense));
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
  /** Contract storage for this trip was archived or its TTL expired. */
  stateArchived: boolean;
  /** The requested event range fell outside the RPC retention window. */
  eventsRetentionExpired: boolean;
  /** True when neither source could produce an authoritative answer. */
  degraded: boolean;
}

/**
 * State-vs-event authority rule
 * ------------------------------
 * When durable contract state and the RPC event stream disagree about a
 * payment, **contract state wins**, with one bounded exception.
 *
 * Why state is authoritative:
 *  - `get_payments` reads the contract's own persistent ledger entries. It is
 *    what the contract itself would act on, and it is what a fresh client on a
 *    new device sees. Events are a side-channel notification derived from the
 *    same transactions, retained by the RPC node for ~24h as a convenience.
 *  - Events are lossy by design (retention pruning, page-budget truncation,
 *    a node that was behind). Absence of an event is therefore never evidence
 *    that a payment did not happen. Absence from live contract state is
 *    meaningful — unless that state is archived (see below).
 *
 * The exception — recency:
 *  - A payment present in events but absent from state is still accepted as
 *    real. Simulation reads a slightly older ledger snapshot than the event
 *    stream, so a just-landed payment legitimately appears in events first.
 *    Accepting it is safe: settlement is monotonic (a share only ever moves
 *    unpaid -> paid) and `markSharePaidRow` is idempotent, so an event-sourced
 *    record that state later confirms causes no double-write, and one that
 *    state would never confirm cannot occur — events are emitted only by
 *    committed transactions.
 *  - Conversely a payment in state but absent from events is always accepted;
 *    that is the ordinary older-than-retention case.
 *
 * So the union is taken, and on a key collision the *state* record is kept as
 * the canonical representation (it carries the settled amount, asset and tx
 * hash straight from contract storage).
 *
 * When state is archived/TTL-expired, it cannot refute anything, so events
 * become the best available evidence and the result is flagged `degraded`.
 */
export async function reconcileTripFromChain(
  tripId: string,
  expenses: Expense[],
  callerPublicKey?: string,
  client?: StellarStarClient,
): Promise<ReconcileTripFromChainResult> {
  let payments: ContractPaymentRecord[] = [];
  let events: ContractPaymentEvent[] = [];
  let stateArchived = false;
  let stateOk = false;
  let eventsRetentionExpired = false;
  let eventsOk = false;

  if (CONTRACT_ID && tripId) {
    // 1. Read durable contract storage — authoritative, survives event pruning.
    try {
      const stateResult = await getContractPayments(callerPublicKey || "", tripId);
      stateArchived = Boolean(stateResult.isArchived);
      // Archived state is "successful" but carries no evidence either way.
      stateOk = stateResult.success && !stateArchived;
      if (stateResult.success && stateResult.payments.length > 0) {
        payments = stateResult.payments;
      }
    } catch (err) {
      console.warn("[reconcile] Contract state read error:", err);
    }

    // 2. Read the live RPC event stream — fresher, but lossy.
    try {
      const eventsResult = await fetchContractEvents(0, tripId);
      eventsRetentionExpired = eventsResult.retentionExpired;
      eventsOk = !eventsResult.retentionExpired && !eventsResult.truncated && !eventsResult.error;
      if (eventsResult.events.length > 0) {
        events = eventsResult.events;
      }
    } catch (err) {
      console.warn("[reconcile] Contract events fetch error:", err);
    }
  }

  // Union, deduplicated on the exact (trip, expense, member, amount, asset) key.
  // Events are inserted first so that a state record with the same key
  // overwrites it — state is the canonical representation per the rule above.
  const combinedMap = new Map<string, PaymentRecordOrEvent>();

  for (const e of events) {
    combinedMap.set(
      buildPaymentEventKey({
        tripId: e.tripId,
        expenseId: e.expenseId,
        member: e.member,
        amountStroops: e.amountStroops,
        asset: e.asset,
      }),
      e,
    );
  }

  for (const p of payments) {
    combinedMap.set(
      buildPaymentEventKey({
        tripId: p.tripId,
        expenseId: p.expenseId,
        member: p.member,
        amountStroops: p.amountStroops,
        asset: p.asset,
      }),
      p,
    );
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
    stateArchived,
    eventsRetentionExpired,
    // Neither source could speak authoritatively: the UI must say "unknown",
    // not "nothing was paid".
    degraded: !stateOk && !eventsOk,
  };
}
