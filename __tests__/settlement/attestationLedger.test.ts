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
  allocateAndCommit,
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

describe("atomic allocateAndCommit & race condition prevention (Issue #231)", () => {
  const TOTAL_PAYMENT = 10_000_000n; // 1 XLM

  it("successfully allocates and commits when within payment capacity", async () => {
    const res = await allocateAndCommit(
      entry({ expenseId: "exp-1", amountStroops: "6000000" }),
      TOTAL_PAYMENT,
    );

    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.entry.amountStroops).toBe("6000000");
      expect(res.reused).toBe(false);
    }

    const check = await inspectAllocation(TX, "exp-other", MEMBER);
    expect(check.allocatedStroops).toBe(6_000_000n);
  });

  it("rejects allocation and does not commit when capacity is exceeded", async () => {
    // Commit 8M
    await commitAttestation(entry({ expenseId: "exp-1", amountStroops: "8000000" }));

    // Try to allocate 3M when only 2M remaining
    const res = await allocateAndCommit(
      entry({ expenseId: "exp-2", amountStroops: "3000000" }),
      TOTAL_PAYMENT,
    );

    expect(res.success).toBe(false);
    if (!res.success) {
      expect(res.reason).toBe("INSUFFICIENT_FUNDS");
      expect(res.allocatedStroops).toBe(8_000_000n);
      expect(res.remainingStroops).toBe(2_000_000n);
    }

    // Ledger should still only have 8M
    const check = await inspectAllocation(TX, "exp-other", MEMBER);
    expect(check.allocatedStroops).toBe(8_000_000n);
  });

  it("re-uses existing attestation idempotently without double-spending", async () => {
    const initial = await allocateAndCommit(
      entry({ expenseId: "exp-1", amountStroops: "5000000" }),
      TOTAL_PAYMENT,
    );
    expect(initial.success).toBe(true);

    const replay = await allocateAndCommit(
      entry({ expenseId: "exp-1", amountStroops: "5000000" }),
      TOTAL_PAYMENT,
    );
    expect(replay.success).toBe(true);
    if (replay.success && initial.success) {
      expect(replay.reused).toBe(true);
      expect(replay.entry.nonce).toBe(initial.entry.nonce);
    }

    // Total allocated must still be only 5M, not 10M
    const check = await inspectAllocation(TX, "exp-other", MEMBER);
    expect(check.allocatedStroops).toBe(5_000_000n);
  });

  it("prevents over-allocation race condition during concurrent requests against the same payment", async () => {
    // Both request 6M against a 10M payment concurrently.
    // If not atomic, both would see 0 allocated and both succeed (total 12M).
    // With atomic allocateAndCommit, exactly ONE succeeds and one fails with INSUFFICIENT_FUNDS.
    const [res1, res2] = await Promise.all([
      allocateAndCommit(
        entry({ expenseId: "exp-concurrent-1", amountStroops: "6000000", nonce: "1".repeat(64) }),
        TOTAL_PAYMENT,
      ),
      allocateAndCommit(
        entry({ expenseId: "exp-concurrent-2", amountStroops: "6000000", nonce: "2".repeat(64) }),
        TOTAL_PAYMENT,
      ),
    ]);

    const successes = [res1, res2].filter((r) => r.success);
    const failures = [res1, res2].filter((r) => !r.success);

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);

    if (!failures[0].success) {
      expect(failures[0].reason).toBe("INSUFFICIENT_FUNDS");
    }

    // Total allocated must be strictly 6M (never 12M)
    const check = await inspectAllocation(TX, "exp-other", MEMBER);
    expect(check.allocatedStroops).toBe(6_000_000n);
  });
});
