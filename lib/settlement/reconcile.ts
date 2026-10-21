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
  recordShareInstallmentRow,
  type DatabaseError,
} from "@/lib/supabase/queries";
import {
  applyInstallment,
  hasInstallments,
  installmentClaimId,
  installmentSeqFromKey,
  installmentsOf,
  parseInstallmentClaimId,
  shareBalance,
} from "@/lib/settlement/installments";
import { verifyPaymentByHash } from "@/lib/settlement/horizonVerify";
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { recordPaymentOnChain, checkIsPaid, getContractPayments } from "@/lib/stellar/contract";
import { fetchContractEvents, buildPaymentEventKey } from "@/lib/stellar/events";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { reportError } from "@/lib/observability/reportError";
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
  needsOnChainSignature?: boolean;
  intent: SettlementIntent;
}

export interface ReconcileOptions {
  /**
   * If true, reconciliation is permitted to trigger active wallet signatures
   * (e.g. popping up Freighter to complete a Soroban contract recording).
   * If false or omitted, reconciliation is strictly read-only and will return
   * a NEEDS_ON_CHAIN_SIGNATURE status if active submission is required.
   */
  allowActiveSubmission?: boolean;
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
  options?: ReconcileOptions,
): Promise<ReconcileIntentResult> {
  // If already fully recorded, reconciliation is a clean no-op (Invariant 6).
  if (intent.status === "recorded" && intent.onChain) {
    return {
      intentId: intent.id,
      reconciled: true,
      onChain: true,
      status: "recorded",
      intent,
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
        intent,
      };
    }
    return {
      intentId: intent.id,
      reconciled: false,
      onChain: false,
      status: intent.status,
      message: "Settlement is still in progress in wallet.",
      intent,
    };
  }

  // 1. Check Horizon: Did the transaction move value on the Stellar ledger?
  let verifiedPayment;
  try {
    verifiedPayment = await verifyPaymentByHash(intent.txHash, intent.requestId);
  } catch (err) {
    // If Horizon cannot find the transaction or verification fails
    const message = err instanceof Error ? err.message : "Horizon verification failed.";
    reportError(
      "reconciliation.failed",
      err,
      {
        stage: "horizon-verify",
        intentId: intent.id,
        txHash: intent.txHash,
        tripId: intent.tripId,
      },
      "warning",
      intent.requestId,
    );
    return {
      intentId: intent.id,
      reconciled: false,
      onChain: false,
      status: intent.status,
      message,
      intent,
    };
  }

  // An installment intent (#325) is attested and recorded on-chain under its
  // own claim id, and is applied to the share as an installment — never as
  // "paid in full".
  const installmentSeq = installmentSeqFromKey(intent.idempotencyKey ?? "");
  const claimExpenseId = installmentSeq ? installmentClaimId(intent.expenseId, installmentSeq) : intent.expenseId;

  if (installmentSeq) {
    let intentStroops: bigint | null = null;
    try {
      intentStroops = Money.parse(intent.amount).toStroops();
    } catch {
      intentStroops = null;
    }
    if (intentStroops === null || verifiedPayment.amountStroops < intentStroops) {
      return {
        intentId: intent.id,
        reconciled: false,
        onChain: false,
        status: intent.status,
        message: "The transaction on Stellar paid less than this installment claims; it was not applied.",
        intent,
      };
    }
  }

  // 2. Horizon confirmed the transaction! Ensure contract is recorded if configured.
  let onChain = intent.onChain;
  let ledger = verifiedPayment.ledger;
  let needsSignature = false;
  let attestationNonce: string | null = null;

  if (CONTRACT_ID && !onChain && intent.tripId) {
    try {
      // Check if already recorded on Soroban contract
      const alreadyOnChain = await checkIsPaid(
        intent.memberWallet,
        claimExpenseId,
        intent.memberWallet,
      );

      if (alreadyOnChain.paid) {
        onChain = true;
      } else {
        // Attempt contract recording
        const attested = await fetchAttestation({
          requestId: intent.requestId,
          tripId: intent.tripId,
          expenseId: claimExpenseId,
          payerPublicKey: intent.payerWallet,
          memberPublicKey: intent.memberWallet,
          amountXlm: intent.amount,
          txHash: intent.txHash,
        });

        if (attested.ok) {
          attestationNonce = attested.attestation?.claim?.nonce ?? null;
          if (options?.allowActiveSubmission ?? true) {
            const contractRes = await recordPaymentOnChain({
              requestId: intent.requestId,
              memberPublicKey: intent.memberWallet,
              tripId: intent.tripId,
              expenseId: claimExpenseId,
              payerPublicKey: intent.payerWallet,
              amountXlm: intent.amount,
              txHash: intent.txHash,
              attestation: attested.attestation,
            });

            if (contractRes.success) {
              onChain = true;
              if (contractRes.ledger) ledger = contractRes.ledger;
            } else {
              reportError(
                "reconciliation.contract-recording-failed",
                new Error(contractRes.error ?? "Contract recording failed during reconciliation"),
                {
                  intentId: intent.id,
                  txHash: intent.txHash,
                  tripId: intent.tripId,
                },
                "warning",
                intent.requestId,
              );
            }
          } else {
            needsSignature = true;
          }
        } else {
          reportError(
            "reconciliation.attestation-failed",
            new Error(attested.message),
            {
              intentId: intent.id,
              txHash: intent.txHash,
              tripId: intent.tripId,
            },
            "warning",
            intent.requestId,
          );
        }
      }
    } catch (err) {
      // Non-fatal: onChain remains false, but financial reality (Horizon payment) is authoritative
      reportError(
        "reconciliation.contract-recording-failed",
        err,
        {
          intentId: intent.id,
          txHash: intent.txHash,
          tripId: intent.tripId,
        },
        "warning",
        intent.requestId,
      );
    }
  }

  // 3. Mark the share paid in Supabase (atomically via markSharePaidRow), or
  //    append the installment — idempotent on the transaction hash.
  try {
    if (installmentSeq) {
      await recordShareInstallmentRow(
        intent.expenseId,
        intent.memberId,
        {
          seq: installmentSeq,
          amount: intent.amount,
          txHash: intent.txHash,
          claimId: claimExpenseId,
          ledger,
          attestationNonce,
          verified: true,
          onChain,
        },
        client,
      );
    } else {
      await markSharePaidRow(intent.expenseId, intent.memberId, intent.txHash, client);
    }
  } catch (err) {
    console.warn("[reconcile] share settlement write warning:", err);
  }

  // 4. Mark intent recorded
  await markIntentRecorded(intent.id, ledger, onChain, client);

  if (needsSignature) {
    return {
      intentId: intent.id,
      reconciled: true,
      onChain: false,
      status: "recorded", // It's recorded in DB, but not on chain
      message: "Needs on-chain signature.",
      needsOnChainSignature: true,
      intent,
    };
  }

  return {
    intentId: intent.id,
    reconciled: true,
    onChain,
    status: "recorded",
    intent,
  };
}

/**
 * Reconciles all pending settlement intents for a wallet from Supabase.
 * Works across any device without requiring localStorage (Invariant 5).
 */
export async function reconcilePendingIntentsForWallet(
  walletAddress: string,
  client?: StellarStarClient,
  options?: ReconcileOptions,
): Promise<ReconcileIntentResult[]> {
  const activeIntents = await fetchActiveSettlementIntents(walletAddress, client);
  const results: ReconcileIntentResult[] = [];

  for (const intent of activeIntents) {
    try {
        const result = await reconcileSettlementIntent(intent, client, options);
      results.push(result);
    } catch (err) {
      console.warn(`[reconcile] Error reconciling intent ${intent.id}:`, err);
      reportError(
        "reconciliation.failed",
        err,
        {
          stage: "reconcilePendingIntentsForWallet",
          intentId: intent.id,
          txHash: intent.txHash,
          tripId: intent.tripId,
        },
        "error",
        intent.requestId,
      );
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

    // Installments are recorded on-chain as `<expenseId>#<seq>` (#325).
    const { expenseId: baseExpenseId, seq: installmentSeq } = parseInstallmentClaimId(payment.expenseId);
    const expense = expenses.find((e) => e.id === baseExpenseId);
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

    if (installmentSeq !== null) {
      const share = expense.shares.find((s) => {
        const shareWallet = (
          s.walletAddress ||
          expense.members.find((m) => m.id === s.memberId)?.walletAddress ||
          ""
        ).trim().toLowerCase();
        return shareWallet === memberLower;
      });
      if (!share) continue;
      const txHash = payment.txHash.trim().toLowerCase();
      if (installmentsOf(share).some((i) => i.txHash.toLowerCase() === txHash)) continue;

      const amount = Money.fromStroops(paymentAmountStroops).format();
      // Pure pre-check: never repair a share past what it owes.
      const applied = applyInstallment(share, {
        seq: installmentSeq,
        amount,
        txHash,
        claimId: payment.expenseId,
      });
      if (!applied.ok || applied.duplicate) continue;

      try {
        await recordShareInstallmentRow(
          expense.id,
          share.memberId,
          { seq: installmentSeq, amount, txHash, claimId: payment.expenseId, verified: true, onChain: true },
          client,
        );
        reconciledCount++;
        if (!repairedExpenseIds.includes(expense.id)) {
          repairedExpenseIds.push(expense.id);
        }
      } catch (err) {
        console.warn(`[reconcile] Failed to repair installment for expense ${expense.id}:`, err);
      }
      continue;
    }

    const share = expense.shares.find((s) => {
      if (s.paid) return false;
      const shareWallet = (
        s.walletAddress ||
        expense.members.find((m) => m.id === s.memberId)?.walletAddress ||
        ""
      ).trim().toLowerCase();

      if (shareWallet !== memberLower) return false;

      // A plain-id record settles the whole share; for a share already part
      // paid that is its remaining balance, never the original amount.
      const shareStroops = hasInstallments(s)
        ? shareBalance(s).remainingStroops
        : parseAmountToStroops(s.amount);
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
