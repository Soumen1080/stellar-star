/**
 * app/api/settlement/reconcile/route.ts
 *
 * Backend settlement reconciliation and re-sync endpoint.
 *
 * Provides a resilient, idempotent upsert path for reconciling payments after
 * client network retries or webhook re-processing.
 *
 * Deduplication is enforced via a deterministic idempotency key derived from:
 *   txHash + expenseId + memberId + assetCode
 * backed by database-level uniqueness constraints.
 *
 * Horizon outages (#416): when Horizon is unreachable or slow, the payment is
 * not abandoned. For a signed-in participant who supplied the payer, member
 * and amount, the route enqueues a durable job on the leased reconciliation
 * queue and answers 202. A worker verifies it once Horizon recovers. The job
 * is keyed on txHash + expenseId + memberId, so client retries during the
 * outage return the same job instead of adding work.
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { CONTRACT_ID } from "@/lib/utils/constants";
import {
  HorizonVerificationError,
  verifyPaymentByHash,
} from "@/lib/settlement/horizonVerify";
import {
  upsertSettlementIntent,
  markIntentRecorded,
  derivePaymentIdempotencyKey,
  type SettlementIntent,
} from "@/lib/settlement/intent";
import {
  markSharePaidRow,
  fetchSettlementIntentByIdempotencyKey,
  fetchSettlementIntentByPayment,
} from "@/lib/supabase/queries";
import { checkIsPaid } from "@/lib/stellar/contract";
import {
  REQUEST_ID_HEADER,
  getOrCreateRequestId,
} from "@/lib/observability/requestId";
import { enqueueOutboxEvent, buildSettlementRecordedOutboxEvent } from "@/lib/outbox";
import { optionalWalletSession } from "@/lib/api/routeGuard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface ReconcileRequestBody {
  txHash?: unknown;
  expenseId?: unknown;
  memberId?: unknown;
  assetCode?: unknown;
  currency?: unknown;
  amount?: unknown;
  payerWallet?: unknown;
  memberWallet?: unknown;
  tripId?: unknown;
}

function responseHeaders(requestId: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    [REQUEST_ID_HEADER]: requestId,
  };
}

function jsonError(message: string, status: number, requestId: string) {
  return NextResponse.json(
    { error: message, requestId },
    { status, headers: responseHeaders(requestId) },
  );
}

function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

const DECIMAL_AMOUNT_RE = /^\d{1,20}(\.\d{1,7})?$/;

/**
 * Hands a payment Horizon could not verify right now to the leased
 * reconciliation queue. Only for a session that is a party to the payment, and
 * only when the body names both wallets and the amount, since the worker must
 * verify against those and cannot take them from Horizon. Returns null when the
 * payment cannot be queued.
 */
async function deferToQueue(args: {
  client: StellarStarClient | undefined;
  sessionWallet: string | null;
  txHash: string;
  tripId: string;
  expenseId: string;
  memberId: string;
  asset: string;
  amount: unknown;
  payerWallet: unknown;
  memberWallet: unknown;
  requestId: string;
}): Promise<{ jobId: string; status: string } | null> {
  if (!args.client || !args.sessionWallet) return null;
  if (!isStellarAddress(args.payerWallet) || !isStellarAddress(args.memberWallet)) return null;
  if (args.sessionWallet !== args.payerWallet && args.sessionWallet !== args.memberWallet) return null;
  if (typeof args.amount !== "string" || !DECIMAL_AMOUNT_RE.test(args.amount.trim())) return null;
  try {
    const job = await enqueueReconciliationJob(
      {
        tripId: args.tripId,
        expenseId: args.expenseId,
        memberId: args.memberId,
        payerWallet: args.payerWallet,
        memberWallet: args.memberWallet,
        asset: args.asset,
        amount: args.amount.trim(),
        requestId: args.requestId,
        txHash: args.txHash,
      },
      args.client,
    );
    return { jobId: job.id, status: job.status };
  } catch (err) {
    console.warn(
      `[reconcile:route] ${JSON.stringify({ requestId: args.requestId, event: "defer-to-queue-failed", message: err instanceof Error ? err.message : String(err) })}`,
    );
    return null;
  }
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  let body: ReconcileRequestBody;
  const parsedBody = await parseJsonBody(request, { route: "/api/settlement/reconcile", requestId });
  if (!parsedBody.ok) return parsedBody.response;
  body = (parsedBody.value) as typeof body;

  const {
    txHash,
    expenseId,
    memberId,
    assetCode,
    currency,
    amount,
    payerWallet,
    memberWallet,
    tripId,
  } = body;

  if (
    typeof txHash !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(txHash) ||
    typeof expenseId !== "string" ||
    expenseId.trim() === "" ||
    typeof memberId !== "string" ||
    memberId.trim() === ""
  ) {
    return jsonError(
      "Missing or malformed reconciliation request fields (txHash, expenseId, memberId required).",
      400,
      requestId,
    );
  }

  const cleanTxHash = txHash.trim().toLowerCase();
  const cleanExpenseId = expenseId.trim();
  const cleanMemberId = memberId.trim();
  const rawAsset = typeof assetCode === "string" ? assetCode : typeof currency === "string" ? currency : "XLM";
  const cleanAsset = rawAsset.trim().toUpperCase() || "XLM";
  const cleanTripId = typeof tripId === "string" && tripId.trim() ? tripId.trim() : "none";

  // Authentication: optional (anonymous webhook re-syncs are allowed), but a
  // session that is present must verify. Shared guard, #419.
  const auth = optionalWalletSession(request, { message: "Invalid or expired wallet session token.", requestId });
  if (!auth.ok) return auth.response;
  const session = auth.ctx?.claims ?? null;
  const serverClient = auth.ctx?.db();

  // Derive deterministic idempotency key: txHash + expenseId + memberId + assetCode
  const idempotencyKey = derivePaymentIdempotencyKey(
    cleanTxHash,
    cleanExpenseId,
    cleanMemberId,
    cleanAsset,
  );

  // Check if intent was already processed/recorded
  let existing: SettlementIntent | null = null;
  try {
    existing = await fetchSettlementIntentByIdempotencyKey(idempotencyKey, serverClient);
    if (!existing) {
      existing = await fetchSettlementIntentByPayment(cleanTxHash, cleanExpenseId, cleanMemberId, serverClient);
    }
  } catch {
    // Non-fatal
  }

  if (existing && existing.status === "recorded") {
    return NextResponse.json(
      {
        ok: true,
        reconciled: true,
        onChain: existing.onChain,
        intent: existing,
        duplicate: true,
        message: "Payment was already reconciled and recorded.",
      },
      { headers: responseHeaders(requestId) },
    );
  }

  // 1. Verify transaction on Horizon
  let payment;
  try {
    payment = await verifyPaymentByHash(cleanTxHash, requestId);
  } catch (err) {
    if (err instanceof HorizonVerificationError && !err.transient) {
      return jsonError(err.message, 422, requestId);
    }
    // Horizon is down or slow: queue the payment rather than drop it.
    const deferred = await deferToQueue({
      client: serverClient,
      sessionWallet: session?.wallet_address ?? null,
      txHash: cleanTxHash,
      tripId: cleanTripId,
      expenseId: cleanExpenseId,
      memberId: cleanMemberId,
      asset: cleanAsset,
      amount,
      payerWallet,
      memberWallet,
      requestId,
    });
    if (deferred) {
      return NextResponse.json(
        {
          ok: true,
          reconciled: false,
          queued: true,
          jobId: deferred.jobId,
          jobStatus: deferred.status,
          message: "Horizon is unavailable; the payment was queued and will be verified automatically.",
          requestId,
        },
        { status: 202, headers: responseHeaders(requestId) },
      );
    }
    if (err instanceof HorizonVerificationError) {
      return jsonError(err.message, 503, requestId);
    }
    return jsonError("Horizon verification failed for transaction.", 503, requestId);
  }

  // Validate addresses if supplied
  if (payerWallet && isStellarAddress(payerWallet) && payment.destination !== payerWallet) {
    return jsonError("Transaction destination does not match the payer wallet.", 422, requestId);
  }
  if (memberWallet && isStellarAddress(memberWallet) && payment.source !== memberWallet) {
    return jsonError("Transaction source does not match the member wallet.", 422, requestId);
  }

  const effectivePayer = (typeof payerWallet === "string" && isStellarAddress(payerWallet)) ? payerWallet : payment.destination;
  const effectiveMember = (typeof memberWallet === "string" && isStellarAddress(memberWallet)) ? memberWallet : payment.source;
  const effectiveAmount = typeof amount === "string" && amount.trim() ? amount.trim() : (Number(payment.amountStroops) / 10_000_000).toString();

  // SEC-F04: When authenticated, verify session wallet is a participant in the payment
  if (session && session.wallet_address !== effectiveMember && session.wallet_address !== effectivePayer) {
    return jsonError("Unauthorized: Session wallet is not a participant in this payment.", 403, requestId);
  }

  // 2. Deterministic upsert into settlement_intents
  let intent: SettlementIntent;
  try {
    intent = await upsertSettlementIntent(
      {
        idempotencyKey,
        requestId,
        tripId: cleanTripId,
        expenseId: cleanExpenseId,
        memberId: cleanMemberId,
        payerWallet: effectivePayer,
        memberWallet: effectiveMember,
        amount: effectiveAmount,
        currency: cleanAsset,
        status: "submitted",
        txHash: cleanTxHash,
        ledger: payment.ledger,
        createdByWallet: effectiveMember,
      },
      serverClient,
    );
  } catch (err) {
    console.error(`[reconcile:route] Failed to upsert settlement intent:`, err);
    return jsonError("Failed to record durable settlement intent.", 500, requestId);
  }

  // 3. Mark the share paid in Supabase
  try {
    await markSharePaidRow(cleanExpenseId, cleanMemberId, cleanTxHash, serverClient);
  } catch (err) {
    console.warn(`[reconcile:route] markSharePaidRow warning:`, err);
  }

  // 4. Check on-chain Soroban contract state
  let onChain = intent.onChain;
  if (CONTRACT_ID && !onChain && cleanTripId !== "none") {
    try {
      const contractCheck = await checkIsPaid(effectiveMember, cleanExpenseId, effectiveMember);
      if (contractCheck.paid) {
        onChain = true;
      }
    } catch {
      // Non-fatal
    }
  }

  // 5. Mark intent as recorded
  let recordedIntent: SettlementIntent = intent;
  try {
    recordedIntent = await markIntentRecorded(intent.id, payment.ledger, onChain, serverClient);

    // Transactional outbox durable promise (#425):
    // Commit consequence into outbox table to guarantee eventual webhook/analytics delivery
    await enqueueOutboxEvent(
      buildSettlementRecordedOutboxEvent({
        intentId: recordedIntent.id,
        tripId: cleanTripId,
        expenseId: cleanExpenseId,
        memberId: cleanMemberId,
        payerWallet: effectivePayer,
        memberWallet: effectiveMember,
        amount: effectiveAmount,
        currency: cleanAsset,
        txHash: cleanTxHash,
        ledger: payment.ledger,
        traceId: requestId,
        createdByWallet: effectiveMember,
      }),
      serverClient
    ).catch((err) => {
      console.warn(`[reconcile:route] Outbox enqueue non-fatal warning:`, err);
    });
  } catch (err) {
    console.warn(`[reconcile:route] Failed to mark intent recorded:`, err);
  }

  return NextResponse.json(
    {
      ok: true,
      reconciled: true,
      onChain,
      intent: recordedIntent,
      ledger: payment.ledger,
    },
    { headers: responseHeaders(requestId) },
  );
}
