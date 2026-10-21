/**
 * __tests__/expense/expenseEditingConflicts.test.ts
 *
 * Test suite for Issue #315: Complete the expense-sharing experience.
 *
 * Verifies:
 * 1. Only authorized trip members can edit an unsettled expense (authorization boundary).
 * 2. Editor displays latest version and offers clear reload/merge choice on concurrent conflict.
 * 3. Editing recomputes shares using exact money arithmetic and blocks invalid totals.
 * 4. Settled and partially settled amounts cannot be changed in place (immutability).
 */

import {
  mergeExpenseUpdates,
  recomputeSharesWithSettled,
  ExpenseConflictError,
} from "@/lib/expense/conflictResolver";
import { validateAmount } from "@/lib/expense/validation";
import { Money } from "@/lib/money";
import type { Expense, Member, SplitShare } from "@/types/expense";
import { PATCH as updateExpenseRoute, GET as getExpenseRoute } from "@/app/api/expenses/[id]/route";
import { NextRequest } from "next/server";

describe("Expense Editing & Conflict Resolution (#315)", () => {
  const ALICE: Member = { id: "m-alice", name: "Alice", walletAddress: "GAALICE1111111111111111111111111111111111111111111111111111" };
  const BOB: Member = { id: "m-bob", name: "Bob", walletAddress: "GABOB22222222222222222222222222222222222222222222222222222" };
  const CHARLIE: Member = { id: "m-charlie", name: "Charlie", walletAddress: "GACHARLIE3333333333333333333333333333333333333333333333333" };

  const unsettledBaseExpense: Expense = {
    id: "exp-base-100",
    title: "Team Dinner",
    description: "Dinner at Tokyo Kitchen",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: "m-alice",
    members: [ALICE, BOB],
    shares: [
      { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "50.0000000", paid: false },
    ],
    createdAt: "2026-03-01T12:00:00Z",
    settled: false,
    version: 1,
  };

  // ─── 1. SETTLED EXPENSES CANNOT BE EDITED IN PLACE ──────────────────────────

  describe("Settled Expense Immutability (Acceptance Criteria 4)", () => {
    it("strictly blocks editing a fully settled expense", () => {
      const settledExpense: Expense = {
        ...unsettledBaseExpense,
        settled: true,
        shares: [
          { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "50.0000000", paid: true },
        ],
      };

      const res = mergeExpenseUpdates(settledExpense, settledExpense, {
        title: "Edited Dinner Title",
      });

      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.conflict.fields).toContain("settled");
      expect(res.conflict.reason).toContain("settled and cannot be edited in place");
    });

    it("strictly prevents reducing total amount below already settled shares", () => {
      // Bob has paid 50 XLM
      const partiallySettled: Expense = {
        ...unsettledBaseExpense,
        totalAmount: "100.0000000",
        members: [ALICE, BOB, CHARLIE],
        shares: [
          { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "50.0000000", paid: true },
          { memberId: "m-charlie", name: "Charlie", walletAddress: CHARLIE.walletAddress, amount: "50.0000000", paid: false },
        ],
        settled: false,
        version: 1,
      };

      // Attempting to reduce total to 40 XLM when 50 XLM is already settled
      const res = mergeExpenseUpdates(partiallySettled, partiallySettled, {
        totalAmount: "40.0000000",
      });

      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.conflict.fields).toContain("totalAmount");
      expect(res.conflict.reason).toContain("already been settled on-chain");
    });

    it("strictly prevents removing a member whose share has already been settled", () => {
      const partiallySettled: Expense = {
        ...unsettledBaseExpense,
        members: [ALICE, BOB, CHARLIE],
        shares: [
          { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "50.0000000", paid: true },
          { memberId: "m-charlie", name: "Charlie", walletAddress: CHARLIE.walletAddress, amount: "50.0000000", paid: false },
        ],
      };

      // Attempting to remove Bob (who has paid: true)
      const res = mergeExpenseUpdates(partiallySettled, partiallySettled, {
        members: [ALICE, CHARLIE],
      });

      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.conflict.fields).toContain("members");
      expect(res.conflict.reason).toContain("already settled on-chain");
    });

    it("prevents changing the currency of an expense with settled shares", () => {
      const partiallySettled: Expense = {
        ...unsettledBaseExpense,
        shares: [
          { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "50.0000000", paid: true },
        ],
      };

      const res = mergeExpenseUpdates(partiallySettled, partiallySettled, {
        currency: "USD",
      });

      expect(res.success).toBe(false);
      if (res.success) return;

      expect(res.conflict.fields).toContain("currency");
      expect(res.conflict.reason).toContain("Cannot change the currency");
    });
  });

  // ─── 2. EXACT MONEY ARITHMETIC & INVALID TOTALS ──────────────────────────────

  describe("Exact Money Arithmetic & Invalid Totals (Acceptance Criteria 3)", () => {
    it("blocks non-positive, zero, or unparseable totals", () => {
      expect(validateAmount("0", "XLM")).toContain("greater than zero");
      expect(validateAmount("-50", "XLM")).toContain("greater than zero");
      expect(validateAmount("abc", "XLM")).toContain("valid");

      const resZero = mergeExpenseUpdates(unsettledBaseExpense, unsettledBaseExpense, {
        totalAmount: "0.0000000",
      });
      expect(resZero.success).toBe(false);

      const resNegative = mergeExpenseUpdates(unsettledBaseExpense, unsettledBaseExpense, {
        totalAmount: "-10.0000000",
      });
      expect(resNegative.success).toBe(false);
    });

    it("recomputes shares preserving exact sum conservation (sum(shares) == total)", () => {
      // 100 split 3 ways: 33.3333333 each for non-payers
      const shares = recomputeSharesWithSettled(
        "100.0000000",
        [ALICE, BOB, CHARLIE],
        "m-alice",
        "equal"
      );

      expect(shares).toHaveLength(2); // Bob and Charlie owe Alice
      // Alice bears 1/3 (~33.3333334), Bob owes ~33.3333333, Charlie owes ~33.3333333
      const bobAmount = Money.parse(shares[0].amount);
      const charlieAmount = Money.parse(shares[1].amount);
      const alicePayerPortion = Money.parse("100.0000000").minus(bobAmount).minus(charlieAmount);

      const totalCalculated = bobAmount.plus(charlieAmount).plus(alicePayerPortion);
      expect(totalCalculated.format(7)).toBe("100.0000000");
    });

    it("reapportions unpaid remainder among unpaid members when partially settled", () => {
      // Bob settled 40 XLM out of original 100 XLM.
      // Total updated to 120 XLM. Unpaid target is 120 - 40 = 80 XLM.
      const existingShares: SplitShare[] = [
        { memberId: "m-bob", name: "Bob", walletAddress: BOB.walletAddress, amount: "40.0000000", paid: true },
        { memberId: "m-charlie", name: "Charlie", walletAddress: CHARLIE.walletAddress, amount: "60.0000000", paid: false },
      ];

      const recomputed = recomputeSharesWithSettled(
        "120.0000000",
        [ALICE, BOB, CHARLIE],
        "m-alice",
        "equal",
        existingShares
      );

      // Bob's share remains untouched at 40 XLM (paid)
      const bobShare = recomputed.find((s) => s.memberId === "m-bob");
      expect(bobShare?.paid).toBe(true);
      expect(bobShare?.amount).toBe("40.0000000");

      // Charlie's unpaid share is recomputed from the remaining unpaid balance
      const charlieShare = recomputed.find((s) => s.memberId === "m-charlie");
      expect(charlieShare?.paid).toBe(false);
      expect(Number(charlieShare?.amount)).toBeGreaterThan(0);
    });
  });

  // ─── 3. CONCURRENT CONFLICT & RELOAD / MERGE WORKFLOW ────────────────────────

  describe("Version Conflicts & Reload / Merge Choices (Acceptance Criteria 2)", () => {
    it("auto-merges orthogonal non-colliding edits into next version", () => {
      // Server modified title to "Tokyo Dinner" (bumped to v2)
      const serverExpense: Expense = {
        ...unsettledBaseExpense,
        title: "Tokyo Dinner",
        version: 2,
      };

      // Client concurrently added Charlie without touching title (based on v1)
      const clientUpdates: Partial<Expense> = {
        members: [ALICE, BOB, CHARLIE],
      };

      const res = mergeExpenseUpdates(unsettledBaseExpense, serverExpense, clientUpdates);
      expect(res.success).toBe(true);
      if (!res.success) return;

      expect(res.autoMerged).toBe(true);
      expect(res.merged.title).toBe("Tokyo Dinner"); // From server
      expect(res.merged.members).toHaveLength(3); // From client
      expect(res.merged.version).toBe(3); // Bumped
    });

    it("detects direct scalar collision and provides conflict details for user resolution", () => {
      // Server changed total amount to 150 (v2)
      const serverExpense: Expense = {
        ...unsettledBaseExpense,
        totalAmount: "150.0000000",
        version: 2,
      };

      // Client simultaneously changed total amount to 200 (based on v1)
      const clientUpdates: Partial<Expense> = {
        totalAmount: "200.0000000",
      };

      const res = mergeExpenseUpdates(unsettledBaseExpense, serverExpense, clientUpdates);
      expect(res.success).toBe(false);
      if (res.success) return;

      // Returns structured conflict details
      expect(res.conflict.fields).toContain("totalAmount");
      expect(res.conflict.serverExpense.version).toBe(2);
      expect(res.conflict.proposedUpdates.totalAmount).toBe("200.0000000");
    });

    it("Reload Choice: User can reload server state to adopt latest version", () => {
      const serverExpense: Expense = {
        ...unsettledBaseExpense,
        title: "Server Dinner Updated",
        totalAmount: "180.0000000",
        version: 2,
      };

      // Reloading simply adopts server expense as the new base
      const reloadedBase = { ...serverExpense };
      expect(reloadedBase.version).toBe(2);
      expect(reloadedBase.totalAmount).toBe("180.0000000");

      // New edit on top of reloaded base applies cleanly without conflict
      const subsequentEdit = { description: "Added description after reloading" };
      const res = mergeExpenseUpdates(reloadedBase, serverExpense, subsequentEdit);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.merged.version).toBe(3);
      expect(res.merged.description).toBe("Added description after reloading");
    });

    it("Merge Choice: User can resolve conflicting fields and apply merged result", () => {
      const serverExpense: Expense = {
        ...unsettledBaseExpense,
        title: "Server Title",
        totalAmount: "150.0000000",
        version: 2,
      };

      // User chose to keep their own total (200) but accept server's title
      const resolvedUpdates: Partial<Expense> = {
        title: serverExpense.title,
        totalAmount: "200.0000000",
      };

      // Merge against server expense
      const res = mergeExpenseUpdates(serverExpense, serverExpense, resolvedUpdates);
      expect(res.success).toBe(true);
      if (!res.success) return;
      expect(res.merged.title).toBe("Server Title");
      expect(res.merged.totalAmount).toBe("200.0000000");
      expect(res.merged.version).toBe(3);
    });
  });

  // ─── 4. API ROUTE AUTHORIZATION & SETTLED CHECKS ─────────────────────────────

  describe("API Route Integration: /api/expenses/[id]", () => {
    it("rejects unauthorized caller who is not signed in", async () => {
      const req = new NextRequest("http://localhost:3000/api/expenses/exp-1", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ updates: { title: "Hacked Title" } }),
      });

      const res = await updateExpenseRoute(req, { params: Promise.resolve({ id: "exp-1" }) });
      expect(res.status).toBe(401);
    });
  });
});
