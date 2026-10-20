/**
 * installments.test.ts — partial settlement of one share (#325).
 *
 * Covers the pure rules every write path shares: exact owed/paid/remaining in
 * stroops, overpayment rejection, "paid" only at exactly zero remaining,
 * transaction-hash idempotency, and that netting and trip balances only ever
 * see the remaining balance of a partly paid share.
 */

import {
  applyInstallment,
  installmentClaimId,
  installmentKeySuffix,
  installmentSeqFromKey,
  parseInstallmentClaimId,
  planInstallment,
  remainingShareAmount,
  shareBalance,
} from "@/lib/settlement/installments";
import { deriveIdempotencyKey } from "@/lib/settlement/intent";
import { computeNetPayments } from "@/lib/settlement/netBalance";
import { computeTripBalances } from "@/lib/export/tripExport";
import { recomputeSharesWithSettled } from "@/lib/expense/conflictResolver";
import type { Expense, SplitShare } from "@/types/expense";
import type { Trip } from "@/types/trip";

const TX_1 = "a".repeat(64);
const TX_2 = "b".repeat(64);
const TX_3 = "c".repeat(64);

function share(overrides: Partial<SplitShare> = {}): SplitShare {
  return {
    memberId: "bob",
    name: "Bob",
    walletAddress: "GBOB",
    amount: "10.0000000",
    paid: false,
    ...overrides,
  };
}

function pay(s: SplitShare, seq: number, amount: string, txHash: string): SplitShare {
  const result = applyInstallment(s, {
    seq,
    amount,
    txHash,
    claimId: installmentClaimId("exp-1", seq),
  });
  if (!result.ok) throw new Error(result.message);
  return result.share;
}

describe("shareBalance", () => {
  it("reports owed, paid and remaining in exact integer stroops", () => {
    const s = pay(share(), 1, "3.3333333", TX_1);
    const balance = shareBalance(s);

    expect(balance.owedStroops).toBe(100_000_000n);
    expect(balance.paidStroops).toBe(33_333_333n);
    expect(balance.remainingStroops).toBe(66_666_667n);
    expect(balance.remaining).toBe("6.6666667");
    expect(balance.partiallyPaid).toBe(true);
    expect(balance.fullySettled).toBe(false);
  });

  it("treats a legacy paid share with no installments as fully paid", () => {
    const balance = shareBalance(share({ paid: true, txHash: TX_1 }));
    expect(balance.remainingStroops).toBe(0n);
    expect(balance.fullySettled).toBe(true);
  });

  it("never loses a stroop across many small installments", () => {
    let s = share({ amount: "1.0000000" });
    for (let seq = 1; seq <= 9; seq++) {
      s = pay(s, seq, "0.1111111", seq.toString(16).repeat(64).slice(0, 64));
    }
    expect(remainingShareAmount(s)).toBe("0.0000001");
    expect(s.paid).toBe(false);

    s = pay(s, 10, "0.0000001", "f".repeat(64));
    expect(remainingShareAmount(s)).toBe("0.0000000");
    expect(s.paid).toBe(true);
  });
});

describe("planInstallment", () => {
  it("defaults to the remaining balance and keeps the single-payment shape", () => {
    const plan = planInstallment(share(), "exp-1");
    expect(plan).toMatchObject({ ok: true, amount: "10.0000000", isFinal: true, isInstallment: false, claimId: null });
  });

  it("marks a partial amount as an installment with its own claim id", () => {
    const plan = planInstallment(share(), "exp-1", "4");
    expect(plan).toMatchObject({
      ok: true,
      seq: 1,
      amount: "4.0000000",
      isFinal: false,
      remainingAfter: "6.0000000",
      isInstallment: true,
      claimId: "exp-1#1",
    });
  });

  it("treats paying the rest of a part-paid share as the final installment", () => {
    const s = pay(share(), 1, "4", TX_1);
    const plan = planInstallment(s, "exp-1");
    expect(plan).toMatchObject({ ok: true, seq: 2, amount: "6.0000000", isFinal: true, isInstallment: true, claimId: "exp-1#2" });
  });

  it("rejects an overpayment by even one stroop", () => {
    const s = pay(share(), 1, "4", TX_1);
    const plan = planInstallment(s, "exp-1", "6.0000001");
    expect(plan).toMatchObject({ ok: false, code: "OVERPAYMENT" });
  });

  it("rejects zero, negative, over-precise and malformed amounts", () => {
    expect(planInstallment(share(), "exp-1", "0")).toMatchObject({ ok: false, code: "NON_POSITIVE" });
    expect(planInstallment(share(), "exp-1", "-1")).toMatchObject({ ok: false, code: "NON_POSITIVE" });
    expect(planInstallment(share(), "exp-1", "1.00000001")).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
    expect(planInstallment(share(), "exp-1", "1e3")).toMatchObject({ ok: false, code: "INVALID_AMOUNT" });
  });

  it("refuses to plan against a settled share", () => {
    expect(planInstallment(share({ paid: true }), "exp-1")).toMatchObject({ ok: false, code: "ALREADY_SETTLED" });
  });
});

describe("applyInstallment", () => {
  it("flips paid only when the installments reach exactly the owed amount", () => {
    let s = pay(share(), 1, "4", TX_1);
    expect(s.paid).toBe(false);
    expect(s.txHash).toBeUndefined();

    s = pay(s, 2, "6", TX_2);
    expect(s.paid).toBe(true);
    expect(s.txHash).toBe(TX_2);
    expect(s.paidStroops).toBe("100000000");
    expect(s.installments?.map((i) => i.seq)).toEqual([1, 2]);
  });

  it("links every installment to its own transaction and claim id", () => {
    const s = pay(pay(share(), 1, "4", TX_1), 2, "1", TX_2);
    expect(s.installments).toEqual([
      expect.objectContaining({ seq: 1, txHash: TX_1, claimId: "exp-1#1", amountStroops: "40000000" }),
      expect.objectContaining({ seq: 2, txHash: TX_2, claimId: "exp-1#2", amountStroops: "10000000" }),
    ]);
  });

  it("is idempotent on the transaction hash (retry after submit)", () => {
    const once = pay(share(), 1, "4", TX_1);
    const again = applyInstallment(once, { seq: 1, amount: "4", txHash: TX_1.toUpperCase(), claimId: "exp-1#1" });
    expect(again).toEqual({ ok: true, share: once, duplicate: true });
    expect(shareBalance(once).paid).toBe("4.0000000");
  });

  it("rejects an installment that would overpay, leaving the share unchanged", () => {
    const s = pay(share(), 1, "8", TX_1);
    const result = applyInstallment(s, { seq: 2, amount: "2.5", txHash: TX_2, claimId: "exp-1#2" });
    expect(result).toMatchObject({ ok: false, code: "OVERPAYMENT" });
    expect(shareBalance(s).remaining).toBe("2.0000000");
  });

  it("rejects further installments once fully settled", () => {
    const s = pay(share(), 1, "10", TX_1);
    expect(applyInstallment(s, { seq: 2, amount: "1", txHash: TX_3, claimId: "exp-1#2" })).toMatchObject({
      ok: false,
      code: "ALREADY_SETTLED",
    });
  });
});

describe("claim ids and intent keys", () => {
  it("round-trips installment claim ids and leaves plain expense ids alone", () => {
    expect(parseInstallmentClaimId(installmentClaimId("exp-1", 12))).toEqual({ expenseId: "exp-1", seq: 12 });
    expect(parseInstallmentClaimId("exp-1")).toEqual({ expenseId: "exp-1", seq: null });
  });

  it("keeps claim ids inside the contract's 64-character id limit", () => {
    const uuid = "123e4567-e89b-12d3-a456-426614174000";
    expect(installmentClaimId(uuid, 999).length).toBeLessThanOrEqual(64);
    expect(() => installmentClaimId(uuid, 1000)).toThrow(RangeError);
  });

  it("gives each installment its own idempotency key, distinct from the one-shot key", () => {
    const oneShot = deriveIdempotencyKey("trip-1", "exp-1", "bob");
    const first = deriveIdempotencyKey("trip-1", "exp-1", "bob", undefined, undefined, 1);
    const second = deriveIdempotencyKey({ tripId: "trip-1", expenseId: "exp-1", memberId: "bob", installmentSeq: 2 });

    expect(new Set([oneShot, first, second]).size).toBe(3);
    expect(first).toBe(`settle:trip-1:exp-1:bob${installmentKeySuffix(1)}`);
    expect(installmentSeqFromKey(second)).toBe(2);
    expect(installmentSeqFromKey(oneShot)).toBeNull();
    // A member id that merely looks like a suffix is not an installment.
    expect(installmentSeqFromKey(deriveIdempotencyKey("trip-1", "exp-1", "i1"))).toBeNull();
  });
});

describe("netting never counts a partial payment as settled", () => {
  const trip: Trip = {
    id: "trip-1",
    name: "Trip",
    members: [
      { id: "alice", name: "Alice", walletAddress: "GALICE" },
      { id: "bob", name: "Bob", walletAddress: "GBOB" },
    ],
    expenseIds: ["exp-1"],
    createdAt: "2026-01-01T00:00:00.000Z",
    settled: false,
  } as Trip;

  function expenseWith(bobShare: SplitShare): Expense {
    return {
      id: "exp-1",
      title: "Dinner",
      totalAmount: "20.0000000",
      currency: "XLM",
      settlementAsset: "native",
      splitMode: "equal",
      paidByMemberId: "alice",
      members: trip.members,
      shares: [
        { memberId: "alice", name: "Alice", walletAddress: "GALICE", amount: "10.0000000", paid: true },
        bobShare,
      ],
      createdAt: "2026-01-01T00:00:00.000Z",
      settled: false,
    };
  }

  it("leaves exactly the remaining balance outstanding in trip balances", () => {
    const balances = computeTripBalances(trip, [expenseWith(pay(share(), 1, "3.5", TX_1))]);
    const bob = balances[0].members.find((m) => m.memberId === "bob");
    expect(bob?.outstanding).toBe("-6.5000000");
  });

  it("nets only the remaining balance, never the original share", () => {
    const partial = pay(share(), 1, "3.5", TX_1);
    const payments = computeNetPayments([
      {
        expenseId: "exp-1",
        fromId: "bob",
        toId: "alice",
        from: "Bob",
        to: "Alice",
        amount: remainingShareAmount(partial),
        asset: "native",
      },
    ]);
    expect(payments).toHaveLength(1);
    expect(payments[0].amount).toBe("6.5000000");
  });

  it("drops the debt only once the final installment lands", () => {
    const settled = pay(pay(share(), 1, "3.5", TX_1), 2, "6.5", TX_2);
    const balances = computeTripBalances(trip, [expenseWith(settled)]);
    expect(balances[0].members.find((m) => m.memberId === "bob")?.outstanding).toBe("0.0000000");
  });

  it("locks a part-paid share's owed amount when an expense is re-split", () => {
    const partial = pay(share(), 1, "3.5", TX_1);
    const shares = recomputeSharesWithSettled(
      "30",
      [
        { id: "alice", name: "Alice" },
        { id: "bob", name: "Bob" },
        { id: "carol", name: "Carol" },
      ],
      "alice",
      "equal",
      [partial],
    );
    expect(shares.find((s) => s.memberId === "bob")).toMatchObject({ amount: "10.0000000" });
  });
});
