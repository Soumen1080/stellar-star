/**
 * The settlement attestation oracle.
 *
 * This endpoint is the trust anchor the contract delegates to. It reads the
 * transaction from Horizon itself, compares what Horizon says against what the
 * caller claimed, and signs the claim only if they agree. The signature is what
 * `record_payment` verifies on-chain.
 *
 * What it deliberately does *not* do: trust anything in the request body about
 * the transaction. The body's `payer`, `member`, and `amountStroops` are
 * treated as assertions to be checked, never as inputs to the signature. The
 * signed claim is built from Horizon's answer.
 */

import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { StrKey } from "@stellar/stellar-sdk";
import { CONTRACT_ID, SETTLEMENT_ASSET_ID } from "@/lib/utils/constants";
import { verifyWalletSession } from "@/lib/supabase/serverAuth";
import {
  buildClaimMessage,
  NONCE_BYTES,
  type SettlementClaim,
} from "@/lib/settlement/attestationMessage";
import {
  isOracleConfigured,
  loadOracleKeypair,
  OracleKeyUnavailableError,
  signClaimMessage,
} from "@/lib/settlement/oracleKey";
import {
  HorizonVerificationError,
  verifyPaymentByHash,
} from "@/lib/settlement/horizonVerify";
import {
  allocateAndCommit,
  commitAttestation,
  inspectAllocation,
  isDurable,
} from "@/lib/settlement/attestationLedger";
import {
  REQUEST_ID_HEADER,
  getOrCreateRequestId,
} from "@/lib/observability/requestId";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Validity window for a minted attestation.
 *
 * Must stay at or below the contract's `MAX_ATTESTATION_TTL_SECS` (900), or
 * every attestation this oracle signs is rejected with AttestationTtlTooLong.
 * Short enough to bound a stolen-key window; long enough to survive a wallet
 * prompt the user walks away from mid-signature.
 */
const ATTESTATION_TTL_SECONDS = 300;

interface AttestRequestBody {
  tripId?: unknown;
  expenseId?: unknown;
  payer?: unknown;
  member?: unknown;
  amountStroops?: unknown;
  txHash?: unknown;
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

function logAttestationError(requestId: string, event: string, error: unknown): void {
  console.error(
    `[StellarStar:settlement-attest] ${JSON.stringify({
      requestId,
      event,
      message: error instanceof Error ? error.message : String(error),
    })}`,
  );
}

function isStellarAddress(value: unknown): value is string {
  return typeof value === "string" && StrKey.isValidEd25519PublicKey(value);
}

function isNonEmptyBoundedString(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

/** The oracle's `G...` address, for a response that reuses a stored signature. */
function oraclePublicKeyOrThrow(): string {
  return loadOracleKeypair().publicKey();
}

export async function POST(request: NextRequest) {
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));

  // ── Deployment prerequisites ───────────────────────────────────────────────
  // 503 rather than 500: invariant 5 says the client must be able to tell
  // "the oracle cannot answer right now" (degrade to off-chain, retry later)
  // from "the oracle says no" (the claim is false, retrying is pointless).
  if (!CONTRACT_ID || !SETTLEMENT_ASSET_ID) {
    return jsonError(
      "Settlement contract or asset is not configured on this deployment.",
      503,
      requestId,
    );
  }
  if (!isOracleConfigured()) {
    return jsonError(
      "The settlement oracle has no signing key configured. On-chain settlement is unavailable.",
      503,
      requestId,
    );
  }

  let body: AttestRequestBody;
  try {
    body = (await request.json()) as AttestRequestBody;
  } catch {
    return jsonError("Request body must be JSON.", 400, requestId);
  }

  const { tripId, expenseId, payer, member, amountStroops, txHash } = body;

  if (
    !isNonEmptyBoundedString(tripId, 64) ||
    !isNonEmptyBoundedString(expenseId, 64) ||
    !isStellarAddress(payer) ||
    !isStellarAddress(member) ||
    typeof amountStroops !== "string" ||
    !/^\d{1,20}$/.test(amountStroops) ||
    typeof txHash !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(txHash)
  ) {
    return jsonError("Missing or malformed attestation request fields.", 400, requestId);
  }

  if (payer === member) {
    return jsonError("Payer and member must be different accounts.", 400, requestId);
  }

  const claimedAmount = BigInt(amountStroops);
  if (claimedAmount <= 0n) {
    return jsonError("Amount must be greater than zero.", 400, requestId);
  }

  // ── Caller must be the member ──────────────────────────────────────────────
  // The oracle attests your settlements, not settlements you nominate someone
  // else for. Without this, anyone could burn a stranger's pool credit by
  // getting an attestation minted in their name.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return jsonError(
      "A valid wallet session is required to request an attestation.",
      401,
      requestId,
    );
  }
  if (session.wallet_address !== member) {
    return jsonError(
      "You may only request attestations for your own settlements.",
      403,
      requestId,
    );
  }

  const normalisedTxHash = txHash.toLowerCase();

  // ── Independent Horizon verification ───────────────────────────────────────
  let payment;
  try {
    payment = await verifyPaymentByHash(normalisedTxHash, requestId);
  } catch (err) {
    if (err instanceof HorizonVerificationError) {
      // Transient Horizon trouble is an availability problem, not a verdict on
      // the claim, so it must not be reported as a rejection.
      logAttestationError(requestId, "horizon-verification-failed", err);
      return jsonError(err.message, err.transient ? 503 : 422, requestId);
    }
    logAttestationError(requestId, "horizon-verification-error", err);
    return jsonError("Could not verify the transaction.", 503, requestId);
  }

  // Horizon's answer is the source of truth. The request's assertions are only
  // ever compared against it — disagreement is a rejection, never a silent
  // substitution of one value for another.
  if (payment.source !== member) {
    return jsonError(
      "The transaction was not sent by your account, so it cannot settle your debt.",
      422,
      requestId,
    );
  }
  if (payment.destination !== payer) {
    return jsonError(
      "The transaction was not sent to the payer of this expense.",
      422,
      requestId,
    );
  }

  // ── Allocation: one payment cannot settle the same debt twice, nor more
  //    debt than it actually paid (atomic check & commit) ─────────────────────
  let allocationResult;
  try {
    allocationResult = await allocateAndCommit({
      txHash: normalisedTxHash,
      expenseId,
      member,
      claimedAmountStroops: claimedAmount,
      totalPaymentStroops: payment.amountStroops,
      createEntry: () => {
        const nonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
        const expiresAt = Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECONDS;

        const claim: SettlementClaim = {
          contractId: CONTRACT_ID,
          tripId,
          expenseId,
          payer,
          member,
          amountStroops: claimedAmount.toString(),
          asset: SETTLEMENT_ASSET_ID,
          txHash: normalisedTxHash,
          nonce,
          expiresAt,
        };

        const signed = signClaimMessage(buildClaimMessage(claim));
        return {
          txHash: normalisedTxHash,
          expenseId,
          member,
          amountStroops: claim.amountStroops,
          nonce,
          expiresAt,
          signature: signed.signature,
        };
      },
    });
  } catch (err) {
    if (err instanceof OracleKeyUnavailableError) {
      return jsonError(err.message, 503, requestId);
    }
    logAttestationError(requestId, "allocation-error", err);
    return jsonError("The attestation ledger is unavailable.", 503, requestId);
  }

  if (!allocationResult.success) {
    if (allocationResult.reason === "AMOUNT_MISMATCH") {
      return jsonError(
        "This expense was already attested against this transaction for a different amount.",
        409,
        requestId,
      );
    }
    return jsonError(
      `This transaction paid ${payment.amountStroops} stroops, of which ` +
        `${allocationResult.allocatedStroops} are already attested. It cannot cover a further ` +
        `${claimedAmount}.`,
      422,
      requestId,
    );
  }

  const stored = allocationResult.entry;
  let oraclePublicKey: string;
  try {
    oraclePublicKey = oraclePublicKeyOrThrow();
  } catch (err) {
    return jsonError(
      err instanceof Error ? err.message : "Oracle key unavailable.",
      503,
      requestId,
    );
  }

  const finalClaim: SettlementClaim = {
    contractId: CONTRACT_ID,
    tripId,
    expenseId,
    payer,
    member,
    amountStroops: stored.amountStroops,
    asset: SETTLEMENT_ASSET_ID,
    txHash: normalisedTxHash,
    nonce: stored.nonce,
    expiresAt: stored.expiresAt,
  };

  return NextResponse.json(
    {
      attestation: {
        claim: finalClaim,
        signature: stored.signature,
        oraclePublicKey,
      },
      reused: allocationResult.reused,
      durableLedger: isDurable(),
      ledger: payment.ledger,
    },
    { headers: responseHeaders(requestId) },
  );
}
