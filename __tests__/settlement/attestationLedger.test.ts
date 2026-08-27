/**
 * Tests for the oracle's allocation ledger.
 *
 * The attack this exists to stop: one real payment, attested separately for
 * several expenses. The contract cannot see that two claims share a
 * transaction, so only the oracle can catch it.
 *
 * These exercise the in-memory backend (no Supabase configured), which is the
 * path a local or single-instance deployment takes.
 */

import {
  commitAttestation,
  inspectAllocation,
  resetMemoryLedger,
  type AttestationLedgerEntry,
} from "@/lib/settlement/attestationLedger";

const TX = "a".repeat(64);
const MEMBER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const OTHER_MEMBER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function entry(overrides: Partial<AttestationLedgerEntry> = {}): AttestationLedgerEntry {
  return {
    txHash: TX,
    expenseId: "exp-1",
    member: MEMBER,
    amountStroops: "10000000",
    nonce: "b".repeat(64),
    expiresAt: 1_900_000_000,
    signature: "c".repeat(128),
    ...overrides,
  };
}

beforeEach(() => {
  resetMemoryLedger();
});

describe("allocation accounting", () => {
  it("reports nothing allocated for an unseen transaction", async () => {
    const result = await inspectAllocation(TX, "exp-1", MEMBER);

    expect(result.existing).toBeNull();
    expect(result.allocatedStroops).toBe(0n);
  });

  it("counts other expenses against the same transaction", async () => {
    // This sum is what the endpoint subtracts from the payment's real value,
    // so a second debt cannot be settled with money already spoken for.
    await commitAttestation(entry({ expenseId: "exp-1", amountStroops: "4000000" }));
    await commitAttestation(entry({ expenseId: "exp-2", amountStroops: "3000000" }));

    const result = await inspectAllocation(TX, "exp-3", MEMBER);

    expect(result.existing).toBeNull();
    expect(result.allocatedStroops).toBe(7_000_000n);
  });

  it("excludes the claim being asked about from the allocated total", async () => {
    // Otherwise re-asking for an existing attestation would look like it
    // needed a second allocation of the same money.
    await commitAttestation(entry({ expenseId: "exp-1", amountStroops: "4000000" }));

    const result = await inspectAllocation(TX, "exp-1", MEMBER);

    expect(result.existing?.expenseId).toBe("exp-1");
    expect(result.allocatedStroops).toBe(0n);
  });

  it("keeps different members' claims separate", async () => {
    await commitAttestation(entry({ member: OTHER_MEMBER, amountStroops: "4000000" }));

    const result = await inspectAllocation(TX, "exp-1", MEMBER);

    expect(result.existing).toBeNull();
    expect(result.allocatedStroops).toBe(4_000_000n);
  });

  it("does not mix allocations across transactions", async () => {
    await commitAttestation(entry({ txHash: "d".repeat(64), amountStroops: "9000000" }));

    const result = await inspectAllocation(TX, "exp-2", MEMBER);

    expect(result.allocatedStroops).toBe(0n);
  });
});

describe("idempotence", () => {
  it("returns the stored attestation instead of minting a second one", async () => {
    // A retry after a dropped response must not consume more of the payment.
    const first = await commitAttestation(entry({ nonce: "1".repeat(64) }));
    const second = await commitAttestation(entry({ nonce: "2".repeat(64) }));

    expect(second.nonce).toBe(first.nonce);
  });

  it("leaves the allocated total unchanged when the same claim is committed twice", async () => {
    await commitAttestation(entry({ expenseId: "exp-1", amountStroops: "4000000" }));
    await commitAttestation(entry({ expenseId: "exp-1", amountStroops: "4000000" }));

    const result = await inspectAllocation(TX, "exp-other", MEMBER);

    expect(result.allocatedStroops).toBe(4_000_000n);
  });
});
