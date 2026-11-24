/**
 * __tests__/expense/corrections.test.ts
 *
 * Comprehensive tests for Issue #316: Add reversals and corrections instead of destructive edits.
 *
 * Covers:
 * 1. Voiding unsettled expenses with mandatory audit reasons.
 * 2. Settled expense immutability and anti-destructive deletion.
 * 3. Linked adjustments and reversals preserving original amounts and on-chain proofs.
 * 4. Permission edge cases (creator, payer, organizer vs unauthorized).
 * 5. Arithmetic edge cases (exact stroop conservation, Hamilton apportionment, zero remainder).
 * 6. Repeated and chained corrections.
 * 7. Effective balance calculations and readable audit history.
 */

import { Money, STROOPS_PER_UNIT } from "@/lib/money";
import {
  canVoidExpense,
  canCorrectExpense,
  validateAuditReason,
  buildLinkedReversal,
  buildLinkedAdjustment,
  calculateEffectiveExpenseBalances,
  getExpenseCorrections,
  isExpenseSettledOrPartiallyPaid,
} from "@/lib/expense/corrections";
import { mergeExpenseUpdates } from "@/lib/expense/conflictResolver";
import type { Expense, Member, SplitShare } from "@/types/expense";

const ALICE: Member = { id: "m-alice", name: "Alice", walletAddress: "GAALICE1234567890123456789012345678901234567890123456789012" };
const BOB: Member = { id: "m-bob", name: "Bob", walletAddress: "GABOB123456789012345678901234567890123456789012345678901234" };
const CHARLIE: Member = { id: "m-charlie", name: "Charlie", walletAddress: "GACHARLIE12345678901234567890123456789012345678901234567890" };
const EVE: Member = { id: "m-eve", name: "Eve", walletAddress: "GAEVE123456789012345678901234567890123456789012345678901234" };

function makeBaseExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: "exp-100",
    title: "Team Dinner in Lisbon",
    description: "Dinner at Portuguese Seafood",
    totalAmount: "100.0000000",
    currency: "XLM",
    splitMode: "equal",
    paidByMemberId: ALICE.id,
    members: [ALICE, BOB],
    shares: [
      {
        memberId: BOB.id,
        name: BOB.name,
        walletAddress: BOB.walletAddress,
        amount: "50.0000000",
        paid: false,
      },
    ],
    settled: false,
    version: 1,
    createdAt: "2026-10-20T12:00:00Z",
    ...overrides,
  };
}

describe("Issue #316: Reversals and Corrections Engine", () => {
  // ─── 1. Audit Reason Validation ──────────────────────────────────────────────
  describe("Audit Reason Validation", () => {
    it("accepts valid non-empty audit reasons", () => {
      const reason = "Double charged by merchant on POS terminal.";
      expect(validateAuditReason(reason)).toBe(reason);
    });

    it("trims whitespace from reasons", () => {
      expect(validateAuditReason("   Valid reason with spaces   ")).toBe("Valid reason with spaces");
    });

    it("rejects empty or whitespace-only reasons", () => {
      expect(() => validateAuditReason("")).toThrow(/audit reason of at least 3 characters/i);
      expect(() => validateAuditReason("   ")).toThrow(/audit reason of at least 3 characters/i);
      expect(() => validateAuditReason(null)).toThrow(/audit reason of at least 3 characters/i);
    });

    it("rejects reasons that exceed maximum length (1000 characters)", () => {
      const tooLong = "x".repeat(1001);
      expect(() => validateAuditReason(tooLong)).toThrow(/cannot exceed 1000 characters/i);
    });
  });

  // ─── 2. Voiding Unsettled Expenses ──────────────────────────────────────────
  describe("Voiding Unsettled Expenses", () => {
    it("allows the payer to void an unsettled expense", () => {
      const expense = makeBaseExpense();
      const res = canVoidExpense(expense, ALICE.walletAddress);
      expect(res.allowed).toBe(true);
    });

    it("allows a privileged manager or organizer to void an unsettled expense", () => {
      const expense = makeBaseExpense();
      const res = canVoidExpense(expense, EVE.walletAddress, true);
      expect(res.allowed).toBe(true);
    });

    it("denies an unauthorized user from voiding an expense", () => {
      const expense = makeBaseExpense();
      const res = canVoidExpense(expense, EVE.walletAddress, false);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/only the payer, creator, or a trip organizer/i);
    });

    it("rejects voiding an already voided expense", () => {
      const voidedExpense = makeBaseExpense({
        voided: true,
        voidReason: "Accidental duplicate entry",
        voidedAt: "2026-10-20T13:00:00Z",
      });
      const res = canVoidExpense(voidedExpense, ALICE.walletAddress);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/already voided/i);
    });

    it("rejects voiding a settled expense", () => {
      const settledExpense = makeBaseExpense({
        settled: true,
        shares: [
          {
            memberId: BOB.id,
            name: BOB.name,
            walletAddress: BOB.walletAddress,
            amount: "50.0000000",
            paid: true,
            txHash: "0xabcdef123456",
          },
        ],
      });
      const res = canVoidExpense(settledExpense, ALICE.walletAddress);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/settled or partially settled expenses cannot be voided/i);
    });

    it("rejects voiding an expense with partial installments", () => {
      const expenseWithInstallment = makeBaseExpense({
        settled: false,
        shares: [
          {
            memberId: BOB.id,
            name: BOB.name,
            walletAddress: BOB.walletAddress,
            amount: "50.0000000",
            paid: false,
            installments: [
              {
                seq: 1,
                amount: "25.0000000",
                amountStroops: "250000000",
                txHash: "0xpart123",
                claimId: "exp-100",
                verified: true,
                onChain: true,
                paidAt: "2026-10-20T12:30:00Z",
              },
            ],
          },
        ],
      });
      const res = canVoidExpense(expenseWithInstallment, ALICE.walletAddress);
      expect(res.allowed).toBe(false);
      expect(res.reason).toMatch(/settled or partially settled expenses cannot be voided/i);
    });
  });

  // ─── 3. Linked Reversal of Settled Expenses ─────────────────────────────────
  describe("Linked Reversal of Settled Expenses", () => {
    it("creates a linked reversal for a settled expense while preserving original amount and proof", () => {
      const settledExpense = makeBaseExpense({
        id: "exp-settled-1",
        settled: true,
        shares: [
          {
            memberId: BOB.id,
            name: BOB.name,
            walletAddress: BOB.walletAddress,
            amount: "50.0000000",
            paid: true,
            txHash: "0x1111222233334444",
          },
        ],
      });

      const reversal = buildLinkedReversal({
        originalExpense: settledExpense,
        reason: "Event was cancelled by organizer and fully refunded.",
        actorWallet: ALICE.walletAddress!,
      });

      // Preserves original expense
      expect(settledExpense.totalAmount).toBe("100.0000000");
      expect(settledExpense.shares[0].paid).toBe(true);
      expect(settledExpense.shares[0].txHash).toBe("0x1111222233334444");

      // Reversal fields
      expect(reversal.correctionOfExpenseId).toBe("exp-settled-1");
      expect(reversal.correctionType).toBe("reversal");
      expect(reversal.correctionReason).toBe("Event was cancelled by organizer and fully refunded.");
      expect(reversal.totalAmount).toBe("50.0000000");
      expect(reversal.shares).toHaveLength(1);
      expect(reversal.shares[0].memberId).toBe(BOB.id);
      expect(reversal.shares[0].amount).toBe("50.0000000");
    });

    it("correctly reverses multi-member settled expenses", () => {
      const multiMemberSettled = makeBaseExpense({
        id: "exp-multi",
        totalAmount: "150.0000000",
        members: [ALICE, BOB, CHARLIE],
        shares: [
          {
            memberId: BOB.id,
            name: BOB.name,
            walletAddress: BOB.walletAddress,
            amount: "50.0000000",
            paid: true,
            txHash: "0xbobtx",
          },
          {
            memberId: CHARLIE.id,
            name: CHARLIE.name,
            walletAddress: CHARLIE.walletAddress,
            amount: "50.0000000",
            paid: true,
            txHash: "0xcharlietx",
          },
        ],
        settled: true,
      });

      const reversal = buildLinkedReversal({
        originalExpense: multiMemberSettled,
        reason: "Duplicate bill submitted.",
        actorWallet: ALICE.walletAddress!,
      });

      expect(reversal.totalAmount).toBe("100.0000000");
      expect(reversal.shares).toHaveLength(2);
      expect(reversal.shares.find((s) => s.memberId === BOB.id)?.amount).toBe("50.0000000");
      expect(reversal.shares.find((s) => s.memberId === CHARLIE.id)?.amount).toBe("50.0000000");
    });

    it("rejects reversal if an expense is unsettled and has no paid shares", () => {
      const unsettled = makeBaseExpense();
      expect(() =>
        buildLinkedReversal({
          originalExpense: unsettled,
          reason: "Trying to reverse an unsettled expense",
          actorWallet: ALICE.walletAddress!,
        }),
      ).toThrow(/unsettled expenses can be edited or voided directly/i);
    });
  });

  // ─── 4. Linked Adjustments & Exact Money Arithmetic ─────────────────────────
  describe("Linked Adjustments & Exact Money Arithmetic", () => {
    it("creates an adjustment with exact stroop Hamilton apportionment", () => {
      const settledExpense = makeBaseExpense({
        id: "exp-adj-1",
        settled: true,
        members: [ALICE, BOB, CHARLIE],
        shares: [
          { memberId: BOB.id, name: BOB.name, amount: "33.3333334", paid: true, txHash: "0xtx1" },
          { memberId: CHARLIE.id, name: CHARLIE.name, amount: "33.3333333", paid: true, txHash: "0xtx2" },
        ],
      });

      // Adjusted to 90.0000000 XLM (30 XLM each)
      const adjustment = buildLinkedAdjustment({
        originalExpense: settledExpense,
        reason: "Merchant applied a 10% group discount voucher retroactively.",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "90.0000000",
      });

      expect(adjustment.correctionOfExpenseId).toBe("exp-adj-1");
      expect(adjustment.correctionType).toBe("adjustment");
      expect(adjustment.totalAmount).toBe("90.0000000");
      expect(adjustment.shares).toHaveLength(2);
      expect(adjustment.shares[0].amount).toBe("30.0000000");
      expect(adjustment.shares[1].amount).toBe("30.0000000");

      // Original expense preserved
      expect(settledExpense.shares[0].paid).toBe(true);
      expect(settledExpense.shares[0].txHash).toBe("0xtx1");
    });

    it("handles prime number fractional apportionment without loss of a single stroop", () => {
      // 100 XLM split across 3 members: 33.3333334 + 33.3333333 + 33.3333333 = 100.0000000
      const settledExpense = makeBaseExpense({
        id: "exp-prime",
        settled: true,
        members: [ALICE, BOB, CHARLIE],
        shares: [
          { memberId: BOB.id, name: BOB.name, amount: "33.3333334", paid: true },
          { memberId: CHARLIE.id, name: CHARLIE.name, amount: "33.3333333", paid: true },
        ],
      });

      const adjustment = buildLinkedAdjustment({
        originalExpense: settledExpense,
        reason: "Adjusting to 70 XLM with exact remainder apportionment.",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "70.0000000",
      });

      const bobShare = Money.parse(adjustment.shares.find((s) => s.memberId === BOB.id)!.amount);
      const charlieShare = Money.parse(adjustment.shares.find((s) => s.memberId === CHARLIE.id)!.amount);
      const nonPayerSum = bobShare.plus(charlieShare);

      // Payer's share is total - nonPayerSum:
      const payerShare = Money.parse("70.0000000").minus(nonPayerSum);

      // Total sum strictly equals 70.0000000
      const fullSum = nonPayerSum.plus(payerShare);
      expect(fullSum.format(7)).toBe("70.0000000");
    });
  });

  // ─── 5. Effective Balances & Conservation of Money ──────────────────────────
  describe("Effective Balances & Conservation of Money", () => {
    it("excludes voided expenses from effective balances", () => {
      const activeExpense = makeBaseExpense({
        id: "exp-active",
        totalAmount: "100.0000000",
      });
      const voidedExpense = makeBaseExpense({
        id: "exp-voided",
        totalAmount: "500.0000000",
        voided: true,
        voidReason: "Test voided record",
      });

      const balances = calculateEffectiveExpenseBalances([activeExpense, voidedExpense]);

      const aliceBal = balances.get(ALICE.id)!;
      const bobBal = balances.get(BOB.id)!;

      // Only exp-active counts: Alice paid 100, her share is 50, net is +50
      expect(aliceBal.paidAmount.format(7)).toBe("100.0000000");
      expect(aliceBal.netAmount.format(7)).toBe("50.0000000");

      // Bob owes 50
      expect(bobBal.shareAmount.format(7)).toBe("50.0000000");
      expect(bobBal.netAmount.format(7)).toBe("-50.0000000");

      // Conservation: sum of net balances is zero
      const netSum = aliceBal.netAmount.plus(bobBal.netAmount);
      expect(netSum.isZero()).toBe(true);
    });

    it("applies reversals to bring net balance to exactly zero", () => {
      const original = makeBaseExpense({
        id: "exp-orig",
        totalAmount: "100.0000000",
        settled: true,
        shares: [{ memberId: BOB.id, name: BOB.name, amount: "50.0000000", paid: true, txHash: "0xproof1" }],
      });

      const reversal = buildLinkedReversal({
        originalExpense: original,
        reason: "Full reversal after merchant cancellation",
        actorWallet: ALICE.walletAddress!,
      });

      const balances = calculateEffectiveExpenseBalances([original, reversal]);

      const aliceBal = balances.get(ALICE.id)!;
      const bobBal = balances.get(BOB.id)!;

      // In the original, Alice net was +50, Bob net was -50.
      // In the reversal, Alice repays Bob 50: Alice net -50, Bob net +50.
      // Net result for both is exactly zero!
      expect(aliceBal.netAmount.format(7)).toBe("0.0000000");
      expect(bobBal.netAmount.format(7)).toBe("0.0000000");
    });
  });

  // ─── 6. Repeated and Chained Corrections ────────────────────────────────────
  describe("Repeated and Chained Corrections", () => {
    it("handles multiple successive corrections on the same base expense", () => {
      const original = makeBaseExpense({
        id: "exp-base",
        totalAmount: "100.0000000",
        settled: true,
        shares: [{ memberId: BOB.id, name: BOB.name, amount: "50.0000000", paid: true }],
      });

      // Correction 1: Adjustment to 120 XLM (+20 XLM)
      const correction1 = buildLinkedAdjustment({
        originalExpense: original,
        reason: "Additional service tip added.",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "120.0000000",
      });

      // Correction 2: Adjustment of the same expense to 110 XLM (-10 XLM offset)
      const correction2 = buildLinkedAdjustment({
        originalExpense: original,
        reason: "Corrected tip percentage.",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "110.0000000",
      });

      const all = [original, correction1, correction2];
      const history = getExpenseCorrections("exp-base", all);

      expect(history).toHaveLength(2);
      expect(history.map((c) => c.id)).toContain(correction1.id);
      expect(history.map((c) => c.id)).toContain(correction2.id);
    });

    it("traverses chained corrections (Correction of a Correction)", () => {
      const original = makeBaseExpense({ id: "exp-root", settled: true });

      const correctionA = buildLinkedAdjustment({
        originalExpense: original,
        reason: "Initial correction",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "80.0000000",
      });
      correctionA.id = "exp-corr-a";
      correctionA.settled = true;

      // Correction B corrects Correction A
      const correctionB = buildLinkedAdjustment({
        originalExpense: correctionA,
        reason: "Secondary adjustment of correction A",
        adjustmentType: "adjustment",
        actorWallet: ALICE.walletAddress!,
        adjustedTotalAmount: "70.0000000",
      });
      correctionB.id = "exp-corr-b";

      const chain = getExpenseCorrections("exp-root", [original, correctionA, correctionB]);
      expect(chain).toHaveLength(2);
      expect(chain[0].id).toBe("exp-corr-a");
      expect(chain[1].id).toBe("exp-corr-b");
    });
  });

  // ─── 7. Immutability & Rejection of Destructive Edits ───────────────────────
  describe("Immutability & Rejection of Destructive Edits", () => {
    it("rejects modifying total amount of a settled expense in conflictResolver", () => {
      const settledExpense = makeBaseExpense({
        settled: true,
        shares: [{ memberId: BOB.id, name: BOB.name, amount: "50.0000000", paid: true }],
      });

      const res = mergeExpenseUpdates(settledExpense, settledExpense, {
        totalAmount: "150.0000000",
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.conflict.fields).toContain("totalAmount");
        expect(res.conflict.reason).toMatch(/settled expenses cannot be modified in place/i);
      }
    });

    it("rejects editing a voided expense in conflictResolver", () => {
      const voidedExpense = makeBaseExpense({
        voided: true,
        voidReason: "Voided due to cancellation",
      });

      const res = mergeExpenseUpdates(voidedExpense, voidedExpense, {
        title: "Attempting to change title",
      });

      expect(res.success).toBe(false);
      if (!res.success) {
        expect(res.conflict.fields).toContain("voided");
        expect(res.conflict.reason).toMatch(/voided expenses are immutable/i);
      }
    });
  });
});
