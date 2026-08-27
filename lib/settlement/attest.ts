/**
 * Seam S3 — settlement attestation client.
 *
 * The trust anchor for on-chain settlement proof. A Soroban contract cannot
 * read Horizon, so it cannot tell a real payment from a `tx_hash` someone typed
 * in. The oracle behind `requestAttestation` does that check server-side and
 * signs the claim; the contract verifies the signature against a key it was
 * initialised with. See `docs/DESIGN_ATTESTATION_ORACLE.md`.
 *
 * This module is client-safe: it holds no signing key and never sees one. The
 * only key it touches is the oracle's *public* key, which is publishable by
 * definition — it is already stored in the contract's instance storage.
 */

import { Keypair } from "@stellar/stellar-sdk";
import { buildClaimMessage, type SettlementClaim } from "@/lib/settlement/attestationMessage";
import { CONTRACT_ID, ORACLE_PUBLIC_KEY, SETTLEMENT_ASSET_ID } from "@/lib/utils/constants";

export type { SettlementClaim };

/**
 * A signed settlement claim: everything the contract needs to accept a
 * `record_payment` call, and nothing it has to take on faith.
 */
export interface Attestation {
  claim: SettlementClaim;
  /** ed25519 signature over `buildClaimMessage(claim)`, lowercase hex. */
  signature: string;
  /** Stellar address (G...) of the signing oracle, for client-side checking. */
  oraclePublicKey: string;
}

/**
 * What the caller asks the oracle for. Deliberately *not* the same shape as a
 * claim: the caller supplies the tx hash as a lookup key and states what it
 * believes the payment was, and the oracle answers with what Horizon actually
 * says. If the two disagree, the request is rejected rather than silently
 * attested with different values.
 */
export interface AttestationRequest {
  tripId: string;
  expenseId: string;
  payer: string;
  member: string;
  amountStroops: string;
  txHash: string;
  /** Session token from /api/auth/verify. The oracle only attests for you. */
  accessToken?: string | null;
}

/** Why an attestation could not be obtained, and whether retrying can help. */
export type AttestationFailureKind =
  /** The oracle is unreachable, erroring, or not configured. Retryable. */
  | "unavailable"
  /** The oracle reached Horizon and refused: the claim is not true. Not retryable. */
  | "rejected";

export class AttestationError extends Error {
  readonly kind: AttestationFailureKind;

  constructor(kind: AttestationFailureKind, message: string) {
    super(message);
    this.name = "AttestationError";
    this.kind = kind;
  }
}

/** True when a settlement can even be attempted on-chain in this deployment. */
export function isAttestationConfigured(): boolean {
  return Boolean(CONTRACT_ID && ORACLE_PUBLIC_KEY && SETTLEMENT_ASSET_ID);
}

interface AttestationResponseBody {
  attestation?: Attestation;
  error?: string;
}

/**
 * Asks the oracle to attest that `txHash` really settles this claim.
 *
 * Throws `AttestationError` with `kind: "unavailable"` when the oracle cannot
 * answer, so callers can degrade to off-chain-recorded and retry later, and
 * `kind: "rejected"` when the oracle answered and said no — which is terminal,
 * because the claim is simply not true and retrying will not make it true.
 */
export async function requestAttestation(claim: AttestationRequest): Promise<Attestation> {
  const { accessToken, ...body } = claim;

  let response: Response;
  try {
    response = await fetch("/api/settlement/attest", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Network error.";
    throw new AttestationError("unavailable", `Could not reach the settlement oracle: ${message}`);
  }

  let parsed: AttestationResponseBody = {};
  try {
    parsed = (await response.json()) as AttestationResponseBody;
  } catch {
    // Fall through to the status-based handling below.
  }

  if (!response.ok) {
    // 4xx is the oracle disagreeing with the claim; 5xx (and 503 in
    // particular, which is what an unconfigured or key-less oracle returns) is
    // the oracle being unable to answer at all.
    const kind: AttestationFailureKind = response.status >= 500 ? "unavailable" : "rejected";
    throw new AttestationError(
      kind,
      parsed.error ?? `Settlement oracle returned HTTP ${response.status}.`,
    );
  }

  if (!parsed.attestation) {
    throw new AttestationError("unavailable", "Settlement oracle returned an empty response.");
  }

  // Check the oracle's own work before spending a wallet signature and a fee
  // on a transaction the contract would reject anyway.
  if (!verifyAttestation(parsed.attestation)) {
    throw new AttestationError(
      "rejected",
      "Settlement oracle returned an attestation that does not verify against the configured oracle key.",
    );
  }

  return parsed.attestation;
}

/**
 * Verifies an attestation's signature against the configured oracle key.
 *
 * This is a client-side sanity check, not the security boundary — the contract
 * does the verification that matters, against the key in its own storage. Its
 * value is catching a misconfigured or swapped-out oracle before the user pays
 * a transaction fee to find out.
 *
 * Returns `false` rather than throwing for any malformed input, so callers can
 * use it as a plain predicate.
 */
export function verifyAttestation(attestation: Attestation): boolean {
  try {
    const expectedOracle = ORACLE_PUBLIC_KEY;
    if (!expectedOracle) return false;
    if (attestation.oraclePublicKey !== expectedOracle) return false;

    const message = buildClaimMessage(attestation.claim);
    const signature = Buffer.from(attestation.signature, "hex");
    if (signature.length !== 64) return false;

    return Keypair.fromPublicKey(expectedOracle).verify(message, signature);
  } catch {
    return false;
  }
}

/** True once an attestation's validity window has closed. */
export function isAttestationExpired(attestation: Attestation, nowMs: number = Date.now()): boolean {
  return attestation.claim.expiresAt * 1000 <= nowMs;
}
