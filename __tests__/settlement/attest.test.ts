/**
 * Adversarial tests for the client half of the attestation seam (S3).
 *
 * The contract-side adversarial suite lives in `contract/src/lib.rs`; these
 * cover what a hostile client can do to the browser-side module and to the
 * canonical message encoding it shares with the contract.
 *
 * The unifying property under test: an `Attestation` is only as good as the
 * exact claim it was signed over. Every case below mutates one field and
 * asserts the signature stops verifying.
 */

import { Keypair } from "@stellar/stellar-sdk";
import {
  buildClaimMessage,
  ATTESTATION_DOMAIN,
  type SettlementClaim,
} from "@/lib/settlement/attestationMessage";

const ORACLE = Keypair.random();

// A second key standing in for an attacker who signs their own attestations.
const ATTACKER = Keypair.random();

const CONTRACT_ID = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4";
const ASSET_ID = "CBQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCV5G";

const MEMBER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const PAYER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function baseClaim(): SettlementClaim {
  return {
    contractId: CONTRACT_ID,
    tripId: "trip-1",
    expenseId: "exp-1",
    payer: PAYER,
    member: MEMBER,
    amountStroops: "10000000",
    asset: ASSET_ID,
    txHash: "a".repeat(64),
    nonce: "b".repeat(64),
    expiresAt: 1_900_000_000,
  };
}

function sign(claim: SettlementClaim, keypair = ORACLE): Buffer {
  return keypair.sign(buildClaimMessage(claim));
}

function verifies(claim: SettlementClaim, signature: Buffer, keypair = ORACLE): boolean {
  return keypair.verify(buildClaimMessage(claim), signature);
}

describe("attestation message encoding", () => {
  it("is deterministic for the same claim", () => {
    expect(buildClaimMessage(baseClaim())).toEqual(buildClaimMessage(baseClaim()));
  });

  it("starts with the domain separation tag", () => {
    // Domain separation is what stops a signature minted for some other
    // stellar-star message type being replayed as a settlement attestation.
    expect(buildClaimMessage(baseClaim()).toString("utf8")).toContain(ATTESTATION_DOMAIN);
  });

  it("rejects a nonce that is not 32 bytes", () => {
    expect(() => buildClaimMessage({ ...baseClaim(), nonce: "abcd" })).toThrow();
  });

  it("rejects a non-hex nonce", () => {
    expect(() => buildClaimMessage({ ...baseClaim(), nonce: "z".repeat(64) })).toThrow();
  });
});

describe("field tampering", () => {
  // Every field in the claim, and the value an attacker would rather it had.
  const tampering: Array<[string, Partial<SettlementClaim>]> = [
    ["trip", { tripId: "trip-2" }],
    ["expense", { expenseId: "exp-2" }],
    ["payer", { payer: MEMBER }],
    ["member", { member: PAYER }],
    ["amount", { amountStroops: "99999999" }],
    ["asset", { asset: CONTRACT_ID }],
    ["tx hash", { txHash: "c".repeat(64) }],
    ["nonce", { nonce: "d".repeat(64) }],
    ["expiry", { expiresAt: 1_999_999_999 }],
    ["contract", { contractId: "CBQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCYLBMFQWCV5G" }],
  ];

  it.each(tampering)("invalidates the signature when the %s changes", (_label, patch) => {
    const claim = baseClaim();
    const signature = sign(claim);

    expect(verifies(claim, signature)).toBe(true);
    expect(verifies({ ...claim, ...patch }, signature)).toBe(false);
  });

  it("keeps the signature valid when nothing changes", () => {
    const claim = baseClaim();
    expect(verifies(claim, sign(claim))).toBe(true);
  });
});

describe("forgery", () => {
  it("does not verify a signature from a key that is not the oracle's", () => {
    const claim = baseClaim();
    const forged = sign(claim, ATTACKER);

    expect(verifies(claim, forged)).toBe(false);
  });

  it("does not verify garbage bytes as a signature", () => {
    expect(verifies(baseClaim(), Buffer.alloc(64))).toBe(false);
  });
});

describe("cross-expense and cross-trip reuse", () => {
  it("cannot move an attestation to another expense in the same trip", () => {
    const claim = baseClaim();
    const signature = sign(claim);

    // The classic attack: one real payment, reused as proof for every debt.
    expect(verifies({ ...claim, expenseId: "exp-other" }, signature)).toBe(false);
  });

  it("cannot move an attestation to another trip", () => {
    const claim = baseClaim();
    const signature = sign(claim);

    expect(verifies({ ...claim, tripId: "trip-other" }, signature)).toBe(false);
  });

  it("cannot reuse another member's attestation", () => {
    const claim = baseClaim();
    const signature = sign(claim);

    expect(verifies({ ...claim, member: PAYER }, signature)).toBe(false);
  });
});

describe("verifyAttestation", () => {
  // The module reads the expected oracle key from constants at import time, so
  // each case sets the env var and loads a fresh copy.
  async function loadModule(oraclePublicKey: string) {
    jest.resetModules();
    process.env.NEXT_PUBLIC_SETTLEMENT_ORACLE_PUBLIC_KEY = oraclePublicKey;
    process.env.NEXT_PUBLIC_CONTRACT_ID = CONTRACT_ID;
    process.env.NEXT_PUBLIC_SETTLEMENT_ASSET_ID = ASSET_ID;
    return import("@/lib/settlement/attest");
  }

  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    jest.resetModules();
  });

  it("accepts an attestation signed by the configured oracle", async () => {
    const { verifyAttestation } = await loadModule(ORACLE.publicKey());
    const claim = baseClaim();

    expect(
      verifyAttestation({
        claim,
        signature: sign(claim).toString("hex"),
        oraclePublicKey: ORACLE.publicKey(),
      }),
    ).toBe(true);
  });

  it("rejects an attestation signed by a different key", async () => {
    const { verifyAttestation } = await loadModule(ORACLE.publicKey());
    const claim = baseClaim();

    expect(
      verifyAttestation({
        claim,
        signature: sign(claim, ATTACKER).toString("hex"),
        oraclePublicKey: ORACLE.publicKey(),
      }),
    ).toBe(false);
  });

  it("rejects an attestation that names an oracle this deployment does not use", async () => {
    // Otherwise an attacker could substitute their own key and have the client
    // happily verify against it.
    const { verifyAttestation } = await loadModule(ORACLE.publicKey());
    const claim = baseClaim();

    expect(
      verifyAttestation({
        claim,
        signature: sign(claim, ATTACKER).toString("hex"),
        oraclePublicKey: ATTACKER.publicKey(),
      }),
    ).toBe(false);
  });

  it("rejects a tampered claim carrying a genuine signature", async () => {
    const { verifyAttestation } = await loadModule(ORACLE.publicKey());
    const claim = baseClaim();
    const signature = sign(claim).toString("hex");

    expect(
      verifyAttestation({
        claim: { ...claim, amountStroops: "1" },
        signature,
        oraclePublicKey: ORACLE.publicKey(),
      }),
    ).toBe(false);
  });

  it("rejects a malformed signature without throwing", async () => {
    const { verifyAttestation } = await loadModule(ORACLE.publicKey());

    expect(
      verifyAttestation({
        claim: baseClaim(),
        signature: "not-hex",
        oraclePublicKey: ORACLE.publicKey(),
      }),
    ).toBe(false);
  });

  it("rejects everything when no oracle key is configured", async () => {
    const { verifyAttestation } = await loadModule("");
    const claim = baseClaim();

    expect(
      verifyAttestation({
        claim,
        signature: sign(claim).toString("hex"),
        oraclePublicKey: ORACLE.publicKey(),
      }),
    ).toBe(false);
  });

  it("reports expiry from the claim's own window", async () => {
    const { isAttestationExpired } = await loadModule(ORACLE.publicKey());
    const claim = baseClaim();
    const attestation = {
      claim,
      signature: sign(claim).toString("hex"),
      oraclePublicKey: ORACLE.publicKey(),
    };

    expect(isAttestationExpired(attestation, claim.expiresAt * 1000 - 1)).toBe(false);
    expect(isAttestationExpired(attestation, claim.expiresAt * 1000)).toBe(true);
  });
});
