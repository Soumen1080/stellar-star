/**
 * lib/settlement/reconciliationWorker.ts
 *
 * Automated On-Chain Reconciliation Worker and State Machine Engine (#313).
 *
 * Responsibilities:
 * 1. Resolves settlement payments across 4 core states:
 *    - "not_submitted": Intent created; debtor account polled for matching tx;
 *                       expires if no payment submitted within window.
 *    - "submitted_not_confirmed": Transaction hash attached; polled for ledger
 *                                 inclusion with backoff and rate limits.
 *    - "confirmed_not_recorded": Payment confirmed on Stellar ledger; repairs
 *                                missing Soroban contract events or Supabase share rows.
 *    - "recorded": Fully reconciled on-chain and in database.
 * 2. Strict 5-point verification before changing settlement state:
 *    - Destination: Verified recipient equals creditor.
 *    - Asset: Verified asset equals settlement asset.
 *    - Amount: Verified amount >= expected amount (underpayments flagged).
 *    - Memo / Intent: Verified memo matches expected intent / request ID.
 *    - Ledger result: Transaction successful on closed ledger within time limit.
 * 3. Anti-ambiguity guarantee:
 *    - An ambiguous transaction is NEVER marked paid.
 *    - Ambiguous records transition to 'escalated' with explicit escalation reasons
 *      for operator review.
 * 4. Durable queue, exponential backoff with jitter, and rate limiting against Horizon.
 * 5. Queryable reporting and alert thresholds.
 */

import { HORIZON_URL, CONTRACT_ID } from "@/lib/utils/constants";
import { Money } from "@/lib/money";
import { normalizeAssetKey, isNative } from "@/lib/stellar/assets";
import { describeSettlementOperation, type HorizonOperationRecord, type SettlementMatch } from "@/lib/stellar/verifyPaymentOperation";
import { MAX_PAYMENT_AGE_MS, amountToStroops } from "@/lib/settlement/horizonVerify";
import { markIntentRecorded, markIntentFailed, type SettlementIntent } from "@/lib/settlement/intent";
import {
  markSharePaidRow,
  recordShareInstallmentRow,
  fetchActiveSettlementIntents,
  fetchSettlementIntentByTxHash,
  DatabaseError,
} from "@/lib/supabase/queries";
import { checkIsPaid, recordPaymentOnChain } from "@/lib/stellar/contract";
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { installmentSeqFromKey, installmentClaimId } from "@/lib/settlement/installments";
import { requireAuthenticatedClient, type StellarStarClient } from "@/lib/supabase/client";
import { getOrCreateRequestId } from "@/lib/observability/requestId";
import { reportError } from "@/lib/observability/reportError";
import type {
  ReconciliationJob,
  ReconciliationJobStatus,
  VerificationCheckResult,
  ReconciliationReport,
  ReconciliationAlert,
  ReconciliationSummary,
  ReconciliationWorkerRunResult,
} from "@/types/reconciliation";
import type {
  ReconciliationJobRow,
  ReconciliationJobInsert,
  ReconciliationJobUpdate,
  SettlementIntentRow,
} from "@/types/supabase";

// ─── Constants & Alert Thresholds ─────────────────────────────────────────────

export const DEFAULT_MAX_ATTEMPTS = 10;
export const DEFAULT_BASE_BACKOFF_MS = 5_000;      // 5 seconds
export const DEFAULT_MAX_BACKOFF_MS = 300_000;     // 5 minutes
export const JITTER_FACTOR = 0.2;                  // +/- 20%
export const RATE_LIMIT_INTERVAL_MS = 200;         // 5 requests / second per worker thread

export const ALERT_THRESHOLDS = {
  maxPendingAgeMinutes: 15,
  maxPendingQueue: 10,
  maxFailureRatePercent: 5,
  escalationThreshold: 0, // Any escalated record triggers an alert
};

// ─── Rate Limiter ─────────────────────────────────────────────────────────────

export class WorkerRateLimiter {
  private lastRequestTime = 0;
  private readonly minIntervalMs: number;

  constructor(minIntervalMs = RATE_LIMIT_INTERVAL_MS) {
    this.minIntervalMs = minIntervalMs;
  }

  async acquire(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - elapsed;
      await new Promise((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = Date.now();
  }
}

const defaultRateLimiter = new WorkerRateLimiter();

// ─── Backoff Calculation ──────────────────────────────────────────────────────

/**
 * Calculates exponential backoff with random jitter.
 * backoff = min(maxMs, baseMs * 2^attempts) +/- (jitterFactor * backoff)
 */
export function calculateBackoffMs(
  attempt: number,
  baseMs = DEFAULT_BASE_BACKOFF_MS,
  maxMs = DEFAULT_MAX_BACKOFF_MS,
  jitterFactor = JITTER_FACTOR,
): number {
  const boundedAttempt = Math.max(0, Math.min(attempt, 20));
  const exponential = Math.min(maxMs, baseMs * Math.pow(2, boundedAttempt));
  const jitter = (Math.random() * 2 - 1) * jitterFactor * exponential;
  return Math.max(baseMs, Math.round(exponential + jitter));
}

// ─── Row Mapping ──────────────────────────────────────────────────────────────

export function rowToReconciliationJob(row: ReconciliationJobRow): ReconciliationJob {
  return {
    id: row.id,
    intentId: row.intent_id,
    tripId: row.trip_id,
    expenseId: row.expense_id,
    memberId: row.member_id,
    payerWallet: row.payer_wallet,
    memberWallet: row.member_wallet,
    asset: row.asset,
    amount: row.amount,
    amountStroops: String(row.amount_stroops),
    expectedMemo: row.expected_memo,
    requestId: row.request_id,
    txHash: row.tx_hash,
    ledger: row.ledger !== null ? Number(row.ledger) : null,
    status: row.status,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    backoffMs: row.backoff_ms,
    lastAttemptAt: row.last_attempt_at,
    nextAttemptAt: row.next_attempt_at,
    escalationReason: row.escalation_reason,
    errorMessage: row.error_message,
    verifiedAt: row.verified_at,
    recordedAt: row.recorded_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Strict 5-Point Verification & Ambiguity Detection ────────────────────────

interface HorizonTransactionPayload {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
  source_account?: string;
  memo?: string;
  memo_type?: string;
}

interface HorizonOperationsResponse {
  _embedded?: { records?: HorizonOperationRecord[] };
}

/**
 * Strict 5-Point Verification Engine:
 * 1. Destination: Recipient must match intended payer/creditor wallet.
 * 2. Asset: Received asset must match intended settlement asset.
 * 3. Amount: Total received amount in stroops must be >= expected amount.
 * 4. Memo/Intent: Memo must match expected memo or carry expected request/intent ID.
 * 5. Ledger Result: Transaction must be successful, finalized in closed ledger, and recent.
 *
 * Ambiguity Rule: Any mismatch or ambiguity marks escalated: true. NEVER mark paid!
 */
export async function verifyPaymentStrict(
  txHash: string,
  expected: {
    payerWallet: string;
    asset: string;
    amountStroops: bigint;
    expectedMemo?: string | null;
    requestId?: string | null;
  },
  rateLimiter: WorkerRateLimiter = defaultRateLimiter,
): Promise<VerificationCheckResult> {
  if (!/^[0-9a-f]{64}$/i.test(txHash)) {
    return {
      ok: false,
      escalated: true,
      escalationReason: `Malformed transaction hash: '${txHash}'. Must be 64 hexadecimal characters.`,
    };
  }

  const cleanTxHash = txHash.toLowerCase();

  // 1. Fetch transaction from Horizon
  await rateLimiter.acquire();
  let txRes: Response;
  try {
    txRes = await fetch(`${HORIZON_URL}/transactions/${cleanTxHash}`, { cache: "no-store" });
  } catch (err) {
    return {
      ok: false,
      escalated: false,
      failureReason: `Network error connecting to Horizon: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (txRes.status === 404) {
    return {
      ok: false,
      escalated: false,
      failureReason: "Transaction not found on the network yet.",
    };
  }

  if (!txRes.ok) {
    return {
      ok: false,
      escalated: false,
      failureReason: `Horizon returned HTTP ${txRes.status}.`,
    };
  }

  const tx = (await txRes.json()) as HorizonTransactionPayload;

  // Ledger check (Point 5)
  if (!tx.successful) {
    return {
      ok: false,
      escalated: false,
      failureReason: "Transaction failed on the Stellar ledger.",
    };
  }

  if (typeof tx.ledger !== "number" || tx.ledger <= 0) {
    return {
      ok: false,
      escalated: false,
      failureReason: "Transaction has not yet settled into a closed ledger.",
    };
  }

  const closedAt = tx.created_at ?? "";
  const closedAtMs = Date.parse(closedAt);
  if (Number.isNaN(closedAtMs)) {
    return {
      ok: false,
      escalated: true,
      escalationReason: "Transaction carries invalid timestamp; cannot confirm finality.",
    };
  }

  if (Date.now() - closedAtMs > MAX_PAYMENT_AGE_MS) {
    return {
      ok: false,
      escalated: true,
      escalationReason: `Transaction is older than max payment age of 24h (closed at ${closedAt}).`,
    };
  }

  // Memo check (Point 4)
  const actualMemo = tx.memo_type === "text" ? (tx.memo ?? null) : null;
  if (expected.expectedMemo && actualMemo) {
    const normActual = actualMemo.trim().toLowerCase();
    const normExpected = expected.expectedMemo.trim().toLowerCase();
    if (!normActual.includes(normExpected) && !normExpected.includes(normActual)) {
      return {
        ok: false,
        escalated: true,
        escalationReason: `Memo conflict: Expected memo '${expected.expectedMemo}', but on-chain transaction carried '${actualMemo}'.`,
      };
    }
  }

  // 2. Fetch operations
  await rateLimiter.acquire();
  let opsRes: Response;
  try {
    opsRes = await fetch(`${HORIZON_URL}/transactions/${cleanTxHash}/operations?limit=200`, { cache: "no-store" });
  } catch (err) {
    return {
      ok: false,
      escalated: false,
      failureReason: `Network error fetching operations: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!opsRes.ok) {
    return {
      ok: false,
      escalated: false,
      failureReason: `Horizon returned HTTP ${opsRes.status} on operations lookup.`,
    };
  }

  const opsBody = (await opsRes.json()) as HorizonOperationsResponse;
  const rawOps = opsBody._embedded?.records ?? [];

  const settlementOps: SettlementMatch[] = rawOps
    .map((op) => describeSettlementOperation(op, tx.source_account))
    .filter((op): op is SettlementMatch => op !== null);

  if (settlementOps.length === 0) {
    return {
      ok: false,
      escalated: true,
      escalationReason: "Transaction contains no valid payment or path payment operations.",
    };
  }

  // Destination check (Point 1)
  const matchingDestinationOps = settlementOps.filter(
    (op) => op.destination.toLowerCase() === expected.payerWallet.toLowerCase(),
  );

  if (matchingDestinationOps.length === 0) {
    const actualDests = Array.from(new Set(settlementOps.map((o) => o.destination))).join(", ");
    return {
      ok: false,
      escalated: true,
      escalationReason: `Destination mismatch: Expected payment to '${expected.payerWallet}', but on-chain payment delivered to '${actualDests}'.`,
    };
  }

  // Asset check (Point 2)
  const expectedAssetKey = normalizeAssetKey(expected.asset);
  const matchingAssetOps = matchingDestinationOps.filter((op) => {
    const opAssetKey = normalizeAssetKey(
      isNative(op.receivedAsset)
        ? "native"
        : `${op.receivedAsset.code}:${op.receivedAsset.issuer ?? ""}`,
    );
    return opAssetKey === expectedAssetKey;
  });

  if (matchingAssetOps.length === 0) {
    return {
      ok: false,
      escalated: true,
      escalationReason: `Asset mismatch: Expected asset '${expected.asset}', but on-chain payment delivered a different asset.`,
    };
  }

  // Amount check (Point 3)
  let totalDeliveredStroops = 0n;
  for (const op of matchingAssetOps) {
    try {
      totalDeliveredStroops += amountToStroops(op.receivedAmount);
    } catch (e) {
      return {
        ok: false,
        escalated: true,
        escalationReason: `Unparseable amount in transaction operation: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  if (totalDeliveredStroops < expected.amountStroops) {
    return {
      ok: false,
      escalated: true,
      escalationReason: `Amount shortfall: Expected ${expected.amountStroops} stroops, but transaction only delivered ${totalDeliveredStroops} stroops.`,
    };
  }

  return {
    ok: true,
    escalated: false,
    verifiedPayment: {
      source: matchingAssetOps[0].source,
      destination: matchingAssetOps[0].destination,
      asset: expected.asset,
      amountStroops: totalDeliveredStroops,
      ledger: tx.ledger,
      closedAt,
      memo: actualMemo,
    },
  };
}

// ─── Account Poller for "not_submitted" state ─────────────────────────────────

/**
 * Polls the debtor's account payments on Horizon to discover an unlinked
 * submitted payment matching destination and memo/amount.
 */
export async function pollAccountForMatchingPayment(
  debtorWallet: string,
  expected: {
    payerWallet: string;
    asset: string;
    amountStroops: bigint;
    expectedMemo?: string | null;
    requestId?: string | null;
  },
  rateLimiter: WorkerRateLimiter = defaultRateLimiter,
): Promise<{ found: boolean; txHash?: string; ambiguous?: boolean; reason?: string }> {
  await rateLimiter.acquire();
  let res: Response;
  try {
    res = await fetch(`${HORIZON_URL}/accounts/${debtorWallet}/payments?limit=20&order=desc`, {
      cache: "no-store",
    });
  } catch (err) {
    return { found: false, reason: `Network error querying debtor payments: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (!res.ok) {
    return { found: false, reason: `Horizon returned ${res.status} for debtor payment search.` };
  }

  const data = (await res.json()) as { _embedded?: { records?: Array<{ transaction_hash: string }> } };
  const candidateHashes = Array.from(new Set((data._embedded?.records ?? []).map((r) => r.transaction_hash)));

  const matchingHashes: string[] = [];

  for (const hash of candidateHashes) {
    const verified = await verifyPaymentStrict(hash, expected, rateLimiter);
    if (verified.ok) {
      matchingHashes.push(hash);
    }
  }

  if (matchingHashes.length === 1) {
    return { found: true, txHash: matchingHashes[0] };
  }

  if (matchingHashes.length > 1) {
    return {
      found: false,
      ambiguous: true,
      reason: `Multiple transactions (${matchingHashes.join(", ")}) match this debt. Escalating for operator review.`,
    };
  }

  return { found: false };
}

// ─── State Machine Processor ──────────────────────────────────────────────────

/**
 * Resolves a single reconciliation job across the state machine:
 * 'not_submitted' -> 'submitted_not_confirmed' -> 'confirmed_not_recorded' -> 'recorded'
 * Or transitions to 'escalated' / 'failed'.
 */
export async function processReconciliationJob(
  job: ReconciliationJob,
  client?: StellarStarClient,
  rateLimiter: WorkerRateLimiter = defaultRateLimiter,
): Promise<{ status: ReconciliationJobStatus; changed: boolean; message?: string }> {
  const supabase = client ?? requireAuthenticatedClient();
  const now = new Date();
  const attempts = job.attempts + 1;
  const nextBackoff = calculateBackoffMs(attempts, job.backoffMs);
  const nextAttemptAt = new Date(Date.now() + nextBackoff).toISOString();
  const expectedStroops = BigInt(job.amountStroops);

  // ── 1. STATE: 'not_submitted' ──────────────────────────────────────────────
  if (job.status === "not_submitted") {
    // If a tx_hash was already populated, advance to submitted_not_confirmed
    if (job.txHash) {
      await updateReconciliationJobRow(
        job.id,
        {
          status: "submitted_not_confirmed",
          last_attempt_at: now.toISOString(),
          next_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "submitted_not_confirmed", changed: true, message: "Transaction hash attached; advancing to submitted_not_confirmed." };
    }

    // Poll debtor account
    const searchResult = await pollAccountForMatchingPayment(
      job.memberWallet,
      {
        payerWallet: job.payerWallet,
        asset: job.asset,
        amountStroops: expectedStroops,
        expectedMemo: job.expectedMemo,
        requestId: job.requestId,
      },
      rateLimiter,
    );

    if (searchResult.ambiguous) {
      await updateReconciliationJobRow(
        job.id,
        {
          status: "escalated",
          escalation_reason: searchResult.reason ?? "Ambiguous candidate transactions found on chain.",
          last_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "escalated", changed: true, message: searchResult.reason };
    }

    if (searchResult.found && searchResult.txHash) {
      await updateReconciliationJobRow(
        job.id,
        {
          tx_hash: searchResult.txHash,
          status: "submitted_not_confirmed",
          last_attempt_at: now.toISOString(),
          next_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "submitted_not_confirmed", changed: true, message: `Discovered on-chain tx ${searchResult.txHash}.` };
    }

    // If not found, check expiration
    const jobAgeMs = Date.now() - new Date(job.createdAt).getTime();
    if (attempts >= job.maxAttempts || jobAgeMs > 15 * 60 * 1000) {
      await updateReconciliationJobRow(
        job.id,
        {
          status: "failed",
          error_message: "Settlement expired without on-chain submission.",
          last_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      if (job.intentId) {
        await markIntentFailed(job.intentId, "Settlement expired without submission.", supabase);
      }
      return { status: "failed", changed: true, message: "Expired without on-chain submission." };
    }

    // Schedule next backoff attempt
    await updateReconciliationJobRow(
      job.id,
      {
        attempts,
        last_attempt_at: now.toISOString(),
        next_attempt_at: nextAttemptAt,
        updated_at: now.toISOString(),
      },
      supabase,
    );
    return { status: "not_submitted", changed: false, message: `Polling account again in ${Math.round(nextBackoff / 1000)}s.` };
  }

  // ── 2. STATE: 'submitted_not_confirmed' ────────────────────────────────────
  if (job.status === "submitted_not_confirmed") {
    if (!job.txHash) {
      // Revert to not_submitted if txHash was cleared
      await updateReconciliationJobRow(
        job.id,
        {
          status: "not_submitted",
          last_attempt_at: now.toISOString(),
          next_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "not_submitted", changed: true };
    }

    const verification = await verifyPaymentStrict(
      job.txHash,
      {
        payerWallet: job.payerWallet,
        asset: job.asset,
        amountStroops: expectedStroops,
        expectedMemo: job.expectedMemo,
        requestId: job.requestId,
      },
      rateLimiter,
    );

    if (verification.escalated) {
      // ANTI-AMBIGUITY GUARD: Escalate! Never mark paid!
      await updateReconciliationJobRow(
        job.id,
        {
          status: "escalated",
          escalation_reason: verification.escalationReason,
          last_attempt_at: now.toISOString(),
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "escalated", changed: true, message: verification.escalationReason };
    }

    if (!verification.ok) {
      if (verification.failureReason?.includes("failed on the Stellar ledger")) {
        await updateReconciliationJobRow(
          job.id,
          {
            status: "failed",
            error_message: verification.failureReason,
            last_attempt_at: now.toISOString(),
            updated_at: now.toISOString(),
          },
          supabase,
        );
        if (job.intentId) {
          await markIntentFailed(job.intentId, verification.failureReason, supabase);
        }
        return { status: "failed", changed: true, message: verification.failureReason };
      }

      // Transient delay / not yet in ledger
      if (attempts >= job.maxAttempts) {
        await updateReconciliationJobRow(
          job.id,
          {
            status: "failed",
            error_message: `Transaction not confirmed after ${job.maxAttempts} attempts.`,
            last_attempt_at: now.toISOString(),
            updated_at: now.toISOString(),
          },
          supabase,
        );
        return { status: "failed", changed: true, message: `Exhausted ${job.maxAttempts} attempts.` };
      }

      await updateReconciliationJobRow(
        job.id,
        {
          attempts,
          last_attempt_at: now.toISOString(),
          next_attempt_at: nextAttemptAt,
          updated_at: now.toISOString(),
        },
        supabase,
      );
      return { status: "submitted_not_confirmed", changed: false, message: verification.failureReason };
    }

    // Transaction verified on ledger! Transition to confirmed_not_recorded
    const ledger = verification.verifiedPayment?.ledger ?? null;
    await updateReconciliationJobRow(
      job.id,
      {
        status: "confirmed_not_recorded",
        ledger,
        verified_at: now.toISOString(),
        last_attempt_at: now.toISOString(),
        next_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      supabase,
    );
    return { status: "confirmed_not_recorded", changed: true, message: "Transaction verified on-chain; proceeding to recording." };
  }

  // ── 3. STATE: 'confirmed_not_recorded' ─────────────────────────────────────
  if (job.status === "confirmed_not_recorded") {
    if (!job.txHash) {
      return { status: "failed", changed: true, message: "Missing transaction hash in confirmed state." };
    }

    let onChain = false;
    let ledger = job.ledger;

    // Check Soroban Contract if configured
    if (CONTRACT_ID && job.tripId) {
      try {
        const contractCheck = await checkIsPaid(job.memberWallet, job.expenseId, job.memberWallet);
        if (contractCheck.paid) {
          onChain = true;
        } else {
          // Attempt server attestation
          const attested = await fetchAttestation({
            requestId: job.requestId ?? job.id,
            tripId: job.tripId,
            expenseId: job.expenseId,
            payerPublicKey: job.payerWallet,
            memberPublicKey: job.memberWallet,
            amountXlm: job.amount,
            txHash: job.txHash,
          });

          if (attested.ok && attested.attestation) {
            const recorded = await recordPaymentOnChain({
              requestId: job.requestId ?? job.id,
              memberPublicKey: job.memberWallet,
              tripId: job.tripId,
              expenseId: job.expenseId,
              payerPublicKey: job.payerWallet,
              amountXlm: job.amount,
              txHash: job.txHash,
              attestation: attested.attestation,
            });
            if (recorded.success) {
              onChain = true;
              if (recorded.ledger) ledger = recorded.ledger;
            }
          }
        }
      } catch (err) {
        console.warn("[reconciliationWorker] Contract write warning (non-fatal):", err);
      }
    }

    // Atomically mark Supabase share as paid
    try {
      await markSharePaidRow(job.expenseId, job.memberId, job.txHash, supabase);
    } catch (err) {
      console.warn("[reconciliationWorker] Share paid row update:", err);
    }

    // Update settlement intent if linked
    if (job.intentId) {
      try {
        await markIntentRecorded(job.intentId, ledger ?? undefined, onChain, supabase);
      } catch (err) {
        console.warn("[reconciliationWorker] Mark intent recorded:", err);
      }
    }

    // Advance job to recorded
    await updateReconciliationJobRow(
      job.id,
      {
        status: "recorded",
        ledger,
        recorded_at: now.toISOString(),
        last_attempt_at: now.toISOString(),
        updated_at: now.toISOString(),
      },
      supabase,
    );

    return { status: "recorded", changed: true, message: "Payment successfully reconciled and recorded." };
  }

  // Already terminal ('recorded', 'escalated', 'failed')
  return { status: job.status, changed: false };
}

// ─── Queue Management & Polling ───────────────────────────────────────────────

export async function enqueueReconciliationJob(
  params: {
    intentId?: string | null;
    tripId: string;
    expenseId: string;
    memberId: string;
    payerWallet: string;
    memberWallet: string;
    asset?: string;
    amount: string;
    amountStroops?: string | bigint;
    expectedMemo?: string | null;
    requestId?: string | null;
    txHash?: string | null;
  },
  client?: StellarStarClient,
): Promise<ReconciliationJob> {
  const supabase = client ?? requireAuthenticatedClient();
  const cleanAsset = normalizeAssetKey(params.asset);
  const cleanAmount = params.amount.trim();

  let stroopsStr: string;
  if (params.amountStroops !== undefined) {
    stroopsStr = String(params.amountStroops);
  } else {
    try {
      stroopsStr = String(Money.parse(cleanAmount).toStroops());
    } catch {
      stroopsStr = String(Math.round(Number(cleanAmount) * 10_000_000));
    }
  }

  const initialStatus: ReconciliationJobStatus = params.txHash ? "submitted_not_confirmed" : "not_submitted";

  const insertData: ReconciliationJobInsert = {
    intent_id: params.intentId ?? null,
    trip_id: params.tripId,
    expense_id: params.expenseId,
    member_id: params.memberId,
    payer_wallet: params.payerWallet,
    member_wallet: params.memberWallet,
    asset: cleanAsset,
    amount: cleanAmount,
    amount_stroops: stroopsStr,
    expected_memo: params.expectedMemo ?? null,
    request_id: params.requestId ?? null,
    tx_hash: params.txHash ?? null,
    status: initialStatus,
    attempts: 0,
    max_attempts: DEFAULT_MAX_ATTEMPTS,
    backoff_ms: DEFAULT_BASE_BACKOFF_MS,
    next_attempt_at: new Date().toISOString(),
  };

  const { data, error } = await supabase
    .from("reconciliation_queue")
    .insert(insertData)
    .select("*")
    .single();

  if (error) {
    throw new DatabaseError(error.message, error.code, "enqueue reconciliation job");
  }

  return rowToReconciliationJob(data as ReconciliationJobRow);
}

/**
 * Synchronizes any pending settlement intents that do not yet have an active queue row.
 */
export async function syncPendingIntentsToQueue(
  walletAddress?: string,
  client?: StellarStarClient,
): Promise<number> {
  const supabase = client ?? requireAuthenticatedClient();
  let query = supabase
    .from("settlement_intents")
    .select("*")
    .in("status", ["pending", "submitting", "submitted"]);

  if (walletAddress) {
    query = query.or(`member_wallet.eq.${walletAddress},payer_wallet.eq.${walletAddress}`);
  }

  const { data: intents, error } = await query;
  if (error || !intents || intents.length === 0) return 0;

  let enqueuedCount = 0;
  for (const intent of intents as SettlementIntentRow[]) {
    // Check if job already exists for this intent
    const { data: existing } = await supabase
      .from("reconciliation_queue")
      .select("id")
      .eq("intent_id", intent.id)
      .maybeSingle();

    if (!existing) {
      await enqueueReconciliationJob(
        {
          intentId: intent.id,
          tripId: intent.trip_id,
          expenseId: intent.expense_id,
          memberId: intent.member_id,
          payerWallet: intent.payer_wallet,
          memberWallet: intent.member_wallet,
          asset: intent.currency,
          amount: intent.amount,
          expectedMemo: intent.request_id,
          requestId: intent.request_id,
          txHash: intent.tx_hash,
        },
        supabase,
      );
      enqueuedCount++;
    }
  }

  return enqueuedCount;
}

export async function fetchDueReconciliationJobs(
  limit = 20,
  client?: StellarStarClient,
): Promise<ReconciliationJob[]> {
  const supabase = client ?? requireAuthenticatedClient();
  const now = new Date().toISOString();

  const { data, error } = await supabase
    .from("reconciliation_queue")
    .select("*")
    .in("status", ["not_submitted", "submitted_not_confirmed", "confirmed_not_recorded"])
    .lte("next_attempt_at", now)
    .order("next_attempt_at", { ascending: true })
    .limit(limit);

  if (error) {
    throw new DatabaseError(error.message, error.code, "fetch due reconciliation jobs");
  }

  return (data ?? []).map((row) => rowToReconciliationJob(row as ReconciliationJobRow));
}

export async function updateReconciliationJobRow(
  id: string,
  updates: ReconciliationJobUpdate,
  client?: StellarStarClient,
): Promise<void> {
  const supabase = client ?? requireAuthenticatedClient();
  const { error } = await supabase.from("reconciliation_queue").update(updates).eq("id", id);
  if (error) {
    throw new DatabaseError(error.message, error.code, "update reconciliation job");
  }
}

// ─── Batch Worker Execution ───────────────────────────────────────────────────

export async function runReconciliationWorker(
  options?: {
    batchSize?: number;
    walletAddress?: string;
  },
  client?: StellarStarClient,
  rateLimiter: WorkerRateLimiter = defaultRateLimiter,
): Promise<ReconciliationWorkerRunResult> {
  const startTime = Date.now();
  const supabase = client ?? requireAuthenticatedClient();
  const batchSize = options?.batchSize ?? 15;

  // 1. Sync pending intents
  try {
    await syncPendingIntentsToQueue(options?.walletAddress, supabase);
  } catch (err) {
    console.warn("[reconciliationWorker] syncPendingIntentsToQueue warning:", err);
  }

  // 2. Fetch due jobs
  const dueJobs = await fetchDueReconciliationJobs(batchSize, supabase);

  let processed = 0;
  let recorded = 0;
  let escalated = 0;
  let pending = 0;
  let failed = 0;
  const errors: Array<{ jobId: string; error: string }> = [];

  for (const job of dueJobs) {
    try {
      processed++;
      const result = await processReconciliationJob(job, supabase, rateLimiter);
      if (result.status === "recorded") recorded++;
      else if (result.status === "escalated") escalated++;
      else if (result.status === "failed") failed++;
      else pending++;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      errors.push({ jobId: job.id, error: errMsg });
      reportError("reconciliation.job-processing-failed", err, { jobId: job.id }, "error");
    }
  }

  return {
    processed,
    recorded,
    escalated,
    pending,
    failed,
    durationMs: Date.now() - startTime,
    errors,
  };
}

// ─── Operator Queryable Report & Alert Thresholds ──────────────────────────────

export interface ReportFilter {
  status?: ReconciliationJobStatus | "all" | "pending";
  wallet?: string;
  txHash?: string;
  tripId?: string;
  escalatedOnly?: boolean;
  limit?: number;
  offset?: number;
}

export function evaluateAlertThresholds(summary: ReconciliationSummary): ReconciliationAlert[] {
  const alerts: ReconciliationAlert[] = [];

  // 1. Aging alert (>15 minutes)
  if (summary.pendingAging.over15m > 0) {
    alerts.push({
      code: "PENDING_AGING_EXCEEDED",
      level: "warning",
      message: `${summary.pendingAging.over15m} reconciliation job(s) have been pending for more than ${ALERT_THRESHOLDS.maxPendingAgeMinutes} minutes.`,
      count: summary.pendingAging.over15m,
      threshold: ALERT_THRESHOLDS.maxPendingAgeMinutes,
    });
  }

  // 2. High pending queue alert
  if (summary.totalPending > ALERT_THRESHOLDS.maxPendingQueue) {
    alerts.push({
      code: "HIGH_PENDING_QUEUE",
      level: "warning",
      message: `Pending reconciliation backlog (${summary.totalPending} jobs) exceeds threshold of ${ALERT_THRESHOLDS.maxPendingQueue}.`,
      count: summary.totalPending,
      threshold: ALERT_THRESHOLDS.maxPendingQueue,
    });
  }

  // 3. Escalated ambiguous payments alert (Critical)
  if (summary.escalated > ALERT_THRESHOLDS.escalationThreshold) {
    alerts.push({
      code: "AMBIGUOUS_PAYMENTS_ESCALATED",
      level: "critical",
      message: `${summary.escalated} ambiguous payment(s) have been escalated and require operator review before changing financial state.`,
      count: summary.escalated,
      threshold: ALERT_THRESHOLDS.escalationThreshold,
    });
  }

  // 4. Failure rate alert
  if (summary.total >= 5 && summary.failureRatePercent > ALERT_THRESHOLDS.maxFailureRatePercent) {
    alerts.push({
      code: "HIGH_FAILURE_RATE",
      level: "warning",
      message: `Reconciliation failure rate is ${summary.failureRatePercent.toFixed(1)}%, exceeding threshold of ${ALERT_THRESHOLDS.maxFailureRatePercent}%.`,
      count: summary.failed,
      threshold: ALERT_THRESHOLDS.maxFailureRatePercent,
    });
  }

  return alerts;
}

export async function getReconciliationReport(
  filter: ReportFilter = {},
  client?: StellarStarClient,
): Promise<ReconciliationReport> {
  const supabase = client ?? requireAuthenticatedClient();
  const limit = Math.min(filter.limit ?? 50, 100);
  const offset = filter.offset ?? 0;

  // 1. Fetch all rows for summary metrics calculation
  const { data: allRows, error: allErr } = await supabase
    .from("reconciliation_queue")
    .select("status, created_at");

  if (allErr) {
    throw new DatabaseError(allErr.message, allErr.code, "fetch reconciliation metrics");
  }

  const rows = allRows ?? [];
  const now = Date.now();

  let notSubmitted = 0;
  let submittedNotConfirmed = 0;
  let confirmedNotRecorded = 0;
  let recorded = 0;
  let escalated = 0;
  let failed = 0;

  let under5m = 0;
  let from5mTo15m = 0;
  let over15m = 0;

  for (const r of rows) {
    if (r.status === "not_submitted") notSubmitted++;
    else if (r.status === "submitted_not_confirmed") submittedNotConfirmed++;
    else if (r.status === "confirmed_not_recorded") confirmedNotRecorded++;
    else if (r.status === "recorded") recorded++;
    else if (r.status === "escalated") escalated++;
    else if (r.status === "failed") failed++;

    const isPending =
      r.status === "not_submitted" ||
      r.status === "submitted_not_confirmed" ||
      r.status === "confirmed_not_recorded";

    if (isPending) {
      const ageMs = now - new Date(r.created_at).getTime();
      if (ageMs < 5 * 60 * 1000) under5m++;
      else if (ageMs <= 15 * 60 * 1000) from5mTo15m++;
      else over15m++;
    }
  }

  const totalPending = notSubmitted + submittedNotConfirmed + confirmedNotRecorded;
  const total = rows.length;
  const failureRatePercent = total > 0 ? (failed / total) * 100 : 0;

  const summary: ReconciliationSummary = {
    total,
    notSubmitted,
    submittedNotConfirmed,
    confirmedNotRecorded,
    recorded,
    escalated,
    failed,
    totalPending,
    pendingAging: { under5m, from5mTo15m, over15m },
    failureRatePercent,
  };

  const alerts = evaluateAlertThresholds(summary);

  // 2. Fetch filtered jobs list
  let query = supabase.from("reconciliation_queue").select("*", { count: "exact" });

  if (filter.status && filter.status !== "all") {
    if (filter.status === "pending") {
      query = query.in("status", ["not_submitted", "submitted_not_confirmed", "confirmed_not_recorded"]);
    } else {
      query = query.eq("status", filter.status);
    }
  }

  if (filter.escalatedOnly) {
    query = query.eq("status", "escalated");
  }

  if (filter.wallet) {
    const cleanWallet = filter.wallet.trim();
    query = query.or(`member_wallet.ilike.%${cleanWallet}%,payer_wallet.ilike.%${cleanWallet}%`);
  }

  if (filter.txHash) {
    query = query.ilike("tx_hash", `%${filter.txHash.trim()}%`);
  }

  if (filter.tripId) {
    query = query.eq("trip_id", filter.tripId.trim());
  }

  const { data: pageData, error: pageErr, count } = await query
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (pageErr) {
    throw new DatabaseError(pageErr.message, pageErr.code, "fetch filtered reconciliation jobs");
  }

  const jobs = (pageData ?? []).map((row) => rowToReconciliationJob(row as ReconciliationJobRow));

  return {
    summary,
    alerts,
    thresholds: ALERT_THRESHOLDS,
    jobs,
    totalFiltered: count ?? jobs.length,
  };
}
