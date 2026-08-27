/**
 * The off-chain half of the attestation message encoding.
 *
 * This must produce the exact same bytes as `claim_message` in
 * `contract/src/attest.rs`. If the two ever drift, every attestation this
 * oracle signs is rejected on-chain — a loud failure, not a silent one, which
 * is the safe direction for a mismatch to break in.
 *
 * The encoding is the concatenation of each field's XDR-encoded `ScVal`, in a
 * fixed order. `ScVal`s are self-delimiting and the order and types are fixed,
 * so plain concatenation is unambiguous — and unlike serialising a struct as a
 * single map, there is no key-ordering convention for the two sides to
 * disagree about.
 */

import { nativeToScVal, xdr } from "@stellar/stellar-sdk";

/**
 * Domain separation tag. Must equal `ATTESTATION_DOMAIN` in
 * `contract/src/attest.rs`. Changing the claim layout requires changing this,
 * so attestations for an older layout stop verifying rather than being
 * reinterpreted under the new one.
 */
export const ATTESTATION_DOMAIN = "stellarstar.settlement.attestation.v1";

/** Nonce length in bytes, matching the contract's `BytesN<32>`. */
export const NONCE_BYTES = 32;

/**
 * One settlement claim, in the exact shape the signature covers.
 *
 * Every field here is bound by the signature: change any one of them and the
 * message changes, so the contract's rebuilt message no longer matches and
 * verification fails. That is what makes cross-expense reuse, amount
 * tampering, and payer substitution all the same non-attack.
 */
export interface SettlementClaim {
  /** Settlement contract address (C...). Binds the claim to one deployment. */
  contractId: string;
  tripId: string;
  expenseId: string;
  /** Stellar address receiving the payment (G...). */
  payer: string;
  /** Stellar address that owes and sent the payment (G...). */
  member: string;
  /** Amount in stroops, as a decimal string. 7 decimals — classic Stellar assets. */
  amountStroops: string;
  /** Settlement asset contract address (C...). Single-asset today; see #43. */
  asset: string;
  /** Horizon transaction hash, lowercase hex. */
  txHash: string;
  /** 32-byte nonce, lowercase hex (64 chars). */
  nonce: string;
  /** Unix seconds after which the contract refuses the attestation. */
  expiresAt: number;
}

function hexToBuffer(hex: string, expectedBytes?: number): Buffer {
  const normalised = hex.trim().toLowerCase();
  if (!/^[0-9a-f]*$/.test(normalised) || normalised.length % 2 !== 0) {
    throw new Error("Expected an even-length lowercase hex string.");
  }
  if (expectedBytes !== undefined && normalised.length !== expectedBytes * 2) {
    throw new Error(`Expected ${expectedBytes} bytes of hex, got ${normalised.length / 2}.`);
  }
  return Buffer.from(normalised, "hex");
}

/**
 * Builds the canonical message the oracle signs and the contract verifies.
 *
 * Field order is load-bearing and mirrors `claim_message` exactly.
 */
export function buildClaimMessage(claim: SettlementClaim): Buffer {
  const parts: xdr.ScVal[] = [
    nativeToScVal(ATTESTATION_DOMAIN, { type: "string" }),
    nativeToScVal(claim.contractId, { type: "address" }),
    nativeToScVal(claim.tripId, { type: "string" }),
    nativeToScVal(claim.expenseId, { type: "string" }),
    nativeToScVal(claim.payer, { type: "address" }),
    nativeToScVal(claim.member, { type: "address" }),
    nativeToScVal(BigInt(claim.amountStroops), { type: "i128" }),
    nativeToScVal(claim.asset, { type: "address" }),
    nativeToScVal(claim.txHash, { type: "string" }),
    xdr.ScVal.scvBytes(hexToBuffer(claim.nonce, NONCE_BYTES)),
    nativeToScVal(BigInt(claim.expiresAt), { type: "u64" }),
  ];

  return Buffer.concat(parts.map((part) => part.toXDR()));
}
