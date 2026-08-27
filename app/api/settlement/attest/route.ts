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
  commitAttestation,
  inspectAllocation,
  isDurable,
} from "@/lib/settlement/attestationLedger";

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

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status, headers: { "Cache-Control": "no-store" } });
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
  // ── Deployment prerequisites ───────────────────────────────────────────────
  // 503 rather than 500: invariant 5 says the client must be able to tell
  // "the oracle cannot answer right now" (degrade to off-chain, retry later)
  // from "the oracle says no" (the claim is false, retrying is pointless).
  if (!CONTRACT_ID || !SETTLEMENT_ASSET_ID) {
    return jsonError(
      "Settlement contract or asset is not configured on this deployment.",
      503,
    );
  }
  if (!isOracleConfigured()) {
    return jsonError(
      "The settlement oracle has no signing key configured. On-chain settlement is unavailable.",
      503,
    );
  }

  let body: AttestRequestBody;
  try {
    body = (await request.json()) as AttestRequestBody;
  } catch {
    return jsonError("Request body must be JSON.", 400);
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
    return jsonError("Missing or malformed attestation request fields.", 400);
  }

  if (payer === member) {
    return jsonError("Payer and member must be different accounts.", 400);
  }

  const claimedAmount = BigInt(amountStroops);
  if (claimedAmount <= 0n) {
    return jsonError("Amount must be greater than zero.", 400);
  }

  // ── Caller must be the member ──────────────────────────────────────────────
  // The oracle attests your settlements, not settlements you nominate someone
  // else for. Without this, anyone could burn a stranger's pool credit by
  // getting an attestation minted in their name.
  const authHeader = request.headers.get("authorization") ?? "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const session = token ? verifyWalletSession(token) : null;

  if (!session) {
    return jsonError("A valid wallet session is required to request an attestation.", 401);
  }
  if (session.wallet_address !== member) {
    return jsonError("You may only request attestations for your own settlements.", 403);
  }

  const normalisedTxHash = txHash.toLowerCase();

  // ── Independent Horizon verification ───────────────────────────────────────
  let payment;
  try {
    payment = await verifyPaymentByHash(normalisedTxHash);
  } catch (err) {
    if (err instanceof HorizonVerificationError) {
      // Transient Horizon trouble is an availability problem, not a verdict on
      // the claim, so it must not be reported as a rejection.
      return jsonError(err.message, err.transient ? 503 : 422);
    }
    console.error("[settlement/attest] Horizon verification error:", err);
    return jsonError("Could not verify the transaction.", 503);
  }

  // Horizon's answer is the source of truth. The request's assertions are only
  // ever compared against it — disagreement is a rejection, never a silent
  // substitution of one value for another.
  if (payment.source !== member) {
    return jsonError(
      "The transaction was not sent by your account, so it cannot settle your debt.",
      422,
    );
  }
  if (payment.destination !== payer) {
    return jsonError("The transaction was not sent to the payer of this expense.", 422);
  }

  // ── Allocation: one payment cannot settle the same debt twice, nor more
  //    debt than it actually paid ────────────────────────────────────────────
  let allocation;
  try {
    allocation = await inspectAllocation(normalisedTxHash, expenseId, member);
  } catch (err) {
    console.error("[settlement/attest] Ledger read error:", err);
    return jsonError("The attestation ledger is unavailable.", 503);
  }

  if (allocation.existing) {
    // Idempotent replay of the same request — a retry after a dropped
    // response gets the same attestation back, not a second one. If the
    // contract already burned its nonce the submission will fail there, which
    // is the correct place for that to be decided.
    if (BigInt(allocation.existing.amountStroops) !== claimedAmount) {
      return jsonError(
        "This expense was already attested against this transaction for a different amount.",
        409,
      );
    }

    let existingOracle: string;
    try {
      existingOracle = oraclePublicKeyOrThrow();
    } catch (err) {
      return jsonError(
        err instanceof Error ? err.message : "Oracle key unavailable.",
        503,
      );
    }

    return NextResponse.json(
      {
        attestation: {
          claim: {
            contractId: CONTRACT_ID,
            tripId,
            expenseId,
            payer,
            member,
            amountStroops: allocation.existing.amountStroops,
            asset: SETTLEMENT_ASSET_ID,
            txHash: normalisedTxHash,
            nonce: allocation.existing.nonce,
            expiresAt: allocation.existing.expiresAt,
          } satisfies SettlementClaim,
          signature: allocation.existing.signature,
          oraclePublicKey: existingOracle,
        },
        reused: true,
        durableLedger: isDurable(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  }

  const remaining = payment.amountStroops - allocation.allocatedStroops;
  if (claimedAmount > remaining) {
    return jsonError(
      `This transaction paid ${payment.amountStroops} stroops, of which ` +
        `${allocation.allocatedStroops} are already attested. It cannot cover a further ` +
        `${claimedAmount}.`,
      422,
    );
  }

  // ── Mint ───────────────────────────────────────────────────────────────────
  const nonce = crypto.randomBytes(NONCE_BYTES).toString("hex");
  const expiresAt = Math.floor(Date.now() / 1000) + ATTESTATION_TTL_SECONDS;

  const claim: SettlementClaim = {
    contractId: CONTRACT_ID,
    tripId,
    expenseId,
    payer,
    member,
    // Horizon confirmed this amount is covered; the claim carries what the
    // caller is settling, bounded above by what was actually paid.
    amountStroops: claimedAmount.toString(),
    asset: SETTLEMENT_ASSET_ID,
    txHash: normalisedTxHash,
    nonce,
    expiresAt,
  };

  let signature: string;
  let oraclePublicKey: string;
  try {
    const signed = signClaimMessage(buildClaimMessage(claim));
    signature = signed.signature;
    oraclePublicKey = signed.publicKey;
  } catch (err) {
    if (err instanceof OracleKeyUnavailableError) {
      return jsonError(err.message, 503);
    }
    console.error("[settlement/attest] Signing error:", err);
    return jsonError("Could not sign the attestation.", 503);
  }

  // Commit before returning: an attestation that reached the caller but not
  // the ledger would be an unaccounted allocation against the payment.
  let stored;
  try {
    stored = await commitAttestation({
      txHash: normalisedTxHash,
      expenseId,
      member,
      amountStroops: claim.amountStroops,
      nonce,
      expiresAt,
      signature,
    });
  } catch (err) {
    console.error("[settlement/attest] Ledger write error:", err);
    return jsonError("Could not record the attestation.", 503);
  }

  // A concurrent request may have won the insert; return whatever is stored so
  // both callers see the same single attestation.
  const finalClaim: SettlementClaim = {
    ...claim,
    amountStroops: stored.amountStroops,
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
      reused: stored.nonce !== nonce,
      durableLedger: isDurable(),
      ledger: payment.ledger,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
