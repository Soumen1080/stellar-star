/**
 * The step between "the XLM moved" and "the contract says so".
 *
 * Both payment hooks need the same sequence — get an attestation, then record
 * on-chain — and, more importantly, the same behaviour when the oracle cannot
 * answer. Invariant 5 is easy to violate by accident in two places
 * independently, so it is implemented once here: an unreachable oracle
 * produces `onChain: false` with a message, never a success that claims proof
 * it does not have.
 */

import {
  AttestationError,
  isAttestationConfigured,
  requestAttestation,
  type Attestation,
} from "@/lib/settlement/attest";
import { getAccessToken } from "@/lib/supabase/session";

/** Stroops per XLM. Classic Stellar assets have exactly 7 decimals. */
const STROOPS_PER_XLM = 10_000_000n;

/** Converts a decimal XLM string to stroops without going through a float. */
export function xlmToStroopsString(xlm: string): string {
  const trimmed = xlm.trim();
  const [whole, fraction = ""] = trimmed.split(".");
  const stroops =
    BigInt(whole || "0") * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, "0").slice(0, 7) || "0");
  return stroops.toString();
}

export interface SettlementClaimInput {
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  memberPublicKey: string;
  amountXlm: string;
  txHash: string;
}

export type AttestationOutcome =
  | { ok: true; attestation: Attestation }
  /**
   * `retryable` distinguishes the two failures the UI must not conflate: an
   * oracle that is down (the debt is real, the payment happened, try again
   * later) from an oracle that looked and said no (nothing to retry).
   */
  | { ok: false; retryable: boolean; message: string };

/**
 * Fetches an attestation for one claim.
 *
 * Never throws: every failure is returned as a value, because the caller has
 * already moved the user's money by this point and must not lose the
 * off-chain record to an exception.
 */
export async function fetchAttestation(
  claim: SettlementClaimInput,
): Promise<AttestationOutcome> {
  if (!isAttestationConfigured()) {
    return {
      ok: false,
      retryable: false,
      message:
        "On-chain settlement proof is not configured for this deployment. " +
        "The payment is recorded off-chain only.",
    };
  }

  try {
    const attestation = await requestAttestation({
      tripId: claim.tripId,
      expenseId: claim.expenseId,
      payer: claim.payerPublicKey,
      member: claim.memberPublicKey,
      amountStroops: xlmToStroopsString(claim.amountXlm),
      txHash: claim.txHash,
      accessToken: getAccessToken(),
    });
    return { ok: true, attestation };
  } catch (err) {
    if (err instanceof AttestationError) {
      return {
        ok: false,
        retryable: err.kind === "unavailable",
        message:
          err.kind === "unavailable"
            ? `${err.message} The payment is recorded off-chain; retry to add on-chain proof.`
            : err.message,
      };
    }
    const message = err instanceof Error ? err.message : "Attestation failed.";
    return { ok: false, retryable: true, message };
  }
}

/** Fetches attestations for every debt in a net settlement, in order. */
export async function fetchAttestationsForDebts(
  base: Omit<SettlementClaimInput, "expenseId" | "amountXlm">,
  debts: { expenseId: string; amountXlm: string }[],
): Promise<
  | { ok: true; attestations: Attestation[] }
  | { ok: false; retryable: boolean; message: string }
> {
  const attestations: Attestation[] = [];

  // Sequential on purpose: the oracle's allocation ledger checks each claim
  // against what the transaction has left to give, and firing them in parallel
  // would race that check against itself.
  for (const debt of debts) {
    const outcome = await fetchAttestation({
      ...base,
      expenseId: debt.expenseId,
      amountXlm: debt.amountXlm,
    });
    if (!outcome.ok) return outcome;
    attestations.push(outcome.attestation);
  }

  return { ok: true, attestations };
}
