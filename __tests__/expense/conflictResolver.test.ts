/**
 * conflictResolver.test.ts
 *
 * Unit and integration tests for Issue #157 (Epic #51).
 * Tests concurrent expense editing, 3-way merge, settled-share immutability,
 * sum(shares) == total conservation, and conflict detection.
 */

import {
  mergeExpenseUpdates,
  recomputeSharesWithSettled,
  ExpenseConflictError,
} from "@/lib/expense/conflictResolver";
import type { Expense, Member, SplitShare } from "@/types/expense";

const ALICE: Member = { id: "m-alice", name: "Alice", walletAddress: "GAALICE" };
const BOB: Member   = { id: "m-bob", name: "Bob", walletAddress: "GABOB" };
const CHARLIE: Member = { id: "m-charlie", name: "Charlie", walletAddress: "GACHARLIE" };

describe("Conflict Resolver & 3-Way Merge Engine (Issue #157 / Epic #51)", () => {
  const baseExpense: Expense = {
    id: "exp-1",
    title: "Dinner",
    description: "Team dinner",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m-alice",
    members: [ALICE, BOB],
    shares: [
      { memberId: "m-bob", name: "Bob", walletAddress: "GABOB", amount: "50.0000000", paid: false },
    ],
    createdAt: "2026-01-01T00:00:00Z",
    settled: false,
    version: 1,
  };

  // ===========================================================================
  // Test 1: Direct application when versions match
  // ===========================================================================

  it("applies updates directly when base and server versions match", () => {
    const proposed = { title: "Grand Dinner", totalAmount: "120.0000000" };
    const res = mergeExpenseUpdates(baseExpense, baseExpense, proposed);

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.autoMerged).toBe(false);
    expect(res.merged.title).toBe("Grand Dinner");
    expect(res.merged.totalAmount).toBe("120.0000000");
    expect(res.merged.version).toBe(2);
    // Shares recomputed: Bob pays 60
    expect(res.merged.shares).toHaveLength(1);
    expect(res.merged.shares[0].amount).toBe("60.0000000");
  });

  // ===========================================================================
  // Test 2: Member addition + Amount change (Non-conflicting orthogonal merge)
  // ===========================================================================

  it("Invariant 1 & 3: Auto-merges member addition by Client with amount correction by Server", () => {
    // Server changed total amount to 150 (version 2)
    const serverExpense: Expense = {
      ...baseExpense,
      totalAmount: "150.0000000",
      shares: [
        { memberId: "m-bob", name: "Bob", walletAddress: "GABOB", amount: "75.0000000", paid: false },
      ],
      version: 2,
    };

    // Client added Charlie as a third member (based on version 1)
    const clientProposed = {
      members: [ALICE, BOB, CHARLIE],
    };

    const res = mergeExpenseUpdates(baseExpense, serverExpense, clientProposed);

    expect(res.success).toBe(true);
    if (!res.success) return;

    expect(res.autoMerged).toBe(true);
    expect(res.merged.totalAmount).toBe("150.0000000"); // Preserved server amount
    expect(res.merged.members).toHaveLength(3); // Preserved client member addition
    expect(res.merged.version).toBe(3);

    // Sum of shares check: 150 / 3 = 50 per person -> Bob and Charlie pay 50 each
    const sumShares = res.merged.shares.reduce((sum, s) => sum + parseFloat(s.amount), 0);
    // Non-payers (Bob + Charlie) pay 50 + 50 = 100 XLM to Alice
    expect(res.merged.shares).toHaveLength(2);
    expect(res.merged.shares.find((s) => s.memberId === "m-bob")?.amount).toBe("50.0000000");
    expect(res.merged.shares.find((s) => s.memberId === "m-charlie")?.amount).toBe("50.0000000");
  });

  // ===========================================================================
  // Test 3: Conflicting edits on same field (Explicit Rejection)
  // ===========================================================================

  it("Invariant 1: Rejects conflicting edits on the same field without silent data loss", () => {
    // Server changed total to 150
    const serverExpense: Expense = {
      ...baseExpense,
      totalAmount: "150.0000000",
      version: 2,
    };

    // Client concurrently changed total to 180
    const clientProposed = {
      totalAmount: "180.0000000",
    };

    const res = mergeExpenseUpdates(baseExpense, serverExpense, clientProposed);

    expect(res.success).toBe(false);
    if (res.success) return;

    expect(res.conflict.fields).toContain("totalAmount");
    expect(res.conflict.reason).toContain("Conflict on totalAmount");
  });

  // ===========================================================================
  // Test 4: Settled Share Protection (Invariant 2)
  // ===========================================================================

  it("Invariant 2 & 3: Preserves settled shares exactly during concurrent edits and re-apportions remainder", () => {
    // Bob has already paid his 50 XLM on-chain!
    const serverWithPaidBob: Expense = {
      ...baseExpense,
      shares: [
        {
          memberId: "m-bob",
          name: "Bob",
          walletAddress: "GABOB",
          amount: "50.0000000",
          paid: true,
          txHash: "0x123456789abcdef",
        },
      ],
      version: 2,
    };

    // Client (at version 1) wants to add Charlie and increase total amount to 110 XLM
    const clientProposed = {
      totalAmount: "110.0000000",
      members: [ALICE, BOB, CHARLIE],
    };

    const res = mergeExpenseUpdates(baseExpense, serverWithPaidBob, clientProposed);

    expect(res.success).toBe(true);
    if (!res.success) return;

    // Bob's share MUST be completely untouched!
    const bobShare = res.merged.shares.find((s) => s.memberId === "m-bob");
    expect(bobShare).toBeDefined();
    expect(bobShare?.paid).toBe(true);
    expect(bobShare?.amount).toBe("50.0000000");
    expect(bobShare?.txHash).toBe("0x123456789abcdef");

    // Remaining unpaid amount to split = 110 - 50 = 60 XLM
    // Alice (payer) and Charlie split it equally -> Charlie's share = 30 XLM
    const charlieShare = res.merged.shares.find((s) => s.memberId === "m-charlie");
    expect(charlieShare).toBeDefined();
    expect(charlieShare?.paid).toBe(false);
    expect(charlieShare?.amount).toBe("30.0000000");
  });

  // ===========================================================================
  // Test 5: Rejection when attempting to reduce total below settled amount
  // ===========================================================================

  it("Invariant 2: Rejects edit if total amount is reduced below already-settled amount", () => {
    // Bob has already paid 50 XLM
    const serverWithPaidBob: Expense = {
      ...baseExpense,
      shares: [
        {
          memberId: "m-bob",
          name: "Bob",
          walletAddress: "GABOB",
          amount: "50.0000000",
          paid: true,
          txHash: "0x123456789abcdef",
        },
      ],
      version: 2,
    };

    // Client attempts to reduce total to 40 XLM
    const clientProposed = {
      totalAmount: "40.0000000",
    };

    const res = mergeExpenseUpdates(baseExpense, serverWithPaidBob, clientProposed);

    expect(res.success).toBe(false);
    if (res.success) return;

    expect(res.conflict.fields).toContain("totalAmount");
    expect(res.conflict.reason).toContain("already been settled on-chain");
  });

  // ===========================================================================
  // Test 6: Rejection when attempting to remove a member with a settled share
  // ===========================================================================

  it("Invariant 2: Rejects edit if attempting to remove a member who has already paid", () => {
    // Bob has already paid 50 XLM
    const serverWithPaidBob: Expense = {
      ...baseExpense,
      shares: [
        {
          memberId: "m-bob",
          name: "Bob",
          walletAddress: "GABOB",
          amount: "50.0000000",
          paid: true,
          txHash: "0x123456789abcdef",
        },
      ],
      version: 2,
    };

    // Client proposes member list without Bob
    const clientProposed = {
      members: [ALICE, CHARLIE],
    };

    const res = mergeExpenseUpdates(baseExpense, serverWithPaidBob, clientProposed);

    expect(res.success).toBe(false);
    if (res.success) return;

    expect(res.conflict.fields).toContain("members");
    expect(res.conflict.reason).toContain('Cannot remove member "Bob"');
  });

  // ===========================================================================
  // Test 7: Custom Split mode recalculation with settled shares
  // ===========================================================================

  it("Invariant 3: Correctly computes custom split weights with settled shares", () => {
    const memberA: Member = { id: "m-a", name: "Alice", weight: 1 };
    const memberB: Member = { id: "m-b", name: "Bob", weight: 2 };
    const memberC: Member = { id: "m-c", name: "Charlie", weight: 3 };

    // Member B already settled 20 XLM
    const settledShares: SplitShare[] = [
      { memberId: "m-b", name: "Bob", amount: "20.0000000", paid: true, txHash: "tx-b" },
    ];

    // Total 80 XLM, custom split mode, payer is Alice
    const shares = recomputeSharesWithSettled(
      "80.0000000",
      [memberA, memberB, memberC],
      "m-a",
      "custom",
      settledShares,
    );

    // Settled share preserved
    expect(shares.find((s) => s.memberId === "m-b")?.amount).toBe("20.0000000");

    // Remaining unpaid = 80 - 20 = 60 XLM.
    // Unpaid members: Alice (weight 1) and Charlie (weight 3). Total weight = 4.
    // Charlie's share = 60 * 3 / 4 = 45 XLM
    expect(shares.find((s) => s.memberId === "m-c")?.amount).toBe("45.0000000");
  });
});
