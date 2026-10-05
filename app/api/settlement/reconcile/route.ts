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
 */

import { NextRequest, NextResponse } from "next/server";
import { StrKey } from "@stellar/stellar-sdk";
import { CONTRACT_ID } from "@/lib/utils/constants";
import { verifyWalletSession, createServerClientForToken } from "@/lib/supabase/serverAuth";
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

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  let body: ReconcileRequestBody;
  try {
    body = (await request.json()) as ReconcileRequestBody;
  } catch {
    return jsonError("Request body must be JSON.", 400, requestId);
  }

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

  // Optional authentication check: if Authorization header is present, verify session
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  let serverClient;

  if (token) {
    const session = verifyWalletSession(token);
    if (!session) {
      return jsonError("Invalid or expired wallet session token.", 401, requestId);
    }
    serverClient = createServerClientForToken(token);
  }

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
    if (err instanceof HorizonVerificationError) {
      return jsonError(err.message, err.transient ? 503 : 422, requestId);
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
