/**
 * proposal.test.ts — settlement proposals and member confirmation (#328).
 */

import {
  authorizeProposalPayment,
  buildProposalSnapshot,
  canonicalJson,
  detectMaterialChanges,
  disputeKey,
  expensesInScope,
  evaluateProposal,
  proposalContentHash,
  proposalMemo,
  proposalPaymentGate,
  proposalReference,
  validateResponse,
  type ProposalResponse,
  type SettlementProposal,
} from "@/lib/settlement/proposal";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { MEMO_PREFIX } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

const ALICE = "GALICE";
const BOB = "GBOB";
const CAROL = "GCAROL";
const NOW = Date.parse("2026-05-01T10:00:00.000Z");
const HOUR = 60 * 60 * 1000;

const trip: Trip = {
  id: "trip-1",
  name: "Alps",
  members: [
    { id: "alice", name: "Alice", walletAddress: ALICE },
    { id: "bob", name: "Bob", walletAddress: BOB },
    { id: "carol", name: "Carol", walletAddress: CAROL },
  ],
  expenseIds: ["exp-1", "exp-2"],
  createdAt: "2026-04-01T00:00:00.000Z",
  settled: false,
} as Trip;

function expense(id: string, overrides: Partial<Expense> = {}): Expense {
  return {
    id,
    title: id,
    totalAmount: "30.0000000",
    currency: "XLM",
    settlementAsset: "native",
    splitMode: "equal",
    paidByMemberId: "alice",
    members: trip.members,
    shares: [
      { memberId: "alice", name: "Alice", walletAddress: ALICE, amount: "10.0000000", paid: true },
      { memberId: "bob", name: "Bob", walletAddress: BOB, amount: "10.0000000", paid: false },
      { memberId: "carol", name: "Carol", walletAddress: CAROL, amount: "10.0000000", paid: false },
    ],
    createdAt: "2026-04-02T00:00:00.000Z",
    settled: false,
    version: 3,
    ...overrides,
  };
}

const baseExpenses = () => [expense("exp-1"), expense("exp-2", { version: 7 })];

function proposalFrom(expenses: Expense[], overrides: Partial<SettlementProposal> = {}): SettlementProposal {
  const snapshot = buildProposalSnapshot({ trip, expenses, creatorWallet: ALICE, nowMs: NOW, ttlMs: 24 * HOUR });
  return {
    id: "prop-1",
    tripId: trip.id,
    creatorWallet: ALICE,
    contentHash: proposalContentHash(snapshot),
    snapshot,
    status: "open",
    expiresAt: snapshot.expiresAt,
    revokedReason: null,
    createdAt: snapshot.createdAt,
    ...overrides,
  };
}

let clock = 0;
function respond(p: SettlementProposal, wallet: string, decision: ProposalResponse["decision"], reason: string | null = null): ProposalResponse {
  clock++;
  return {
    memberId: wallet.toLowerCase(),
    wallet,
    decision,
    reason,
    contentHash: p.contentHash,
    createdAt: new Date(NOW + clock * 1000).toISOString(),
  };
}

const evaluate = (p: SettlementProposal, responses: ProposalResponse[], expenses = baseExpenses(), nowMs = NOW + HOUR) =>
  evaluateProposal(p, responses, { trip, expenses, nowMs });

const approvedBy = (p: SettlementProposal) => [respond(p, ALICE, "approve"), respond(p, BOB, "approve"), respond(p, CAROL, "approve")];

describe("the frozen snapshot", () => {
  it("excludes disputed unpaid shares from a fresh snapshot without changing paid shares", () => {
    const rows = baseExpenses();
    const disputedShares = new Set([disputeKey("exp-1", "bob")]);
    const snapshot = buildProposalSnapshot({ trip, expenses: rows, disputedShares, creatorWallet: ALICE, nowMs: NOW, ttlMs: 24 * HOUR });
    const exp1 = snapshot.expenses.find((item) => item.id === "exp-1")!;
    expect(exp1.shares.find((share) => share.memberId === "bob")?.paid).toBe(false);
    expect(snapshot.transfers.some((transfer) => transfer.expenseIds.includes("exp-1") && transfer.fromId === "bob")).toBe(false);
    expect(snapshot.transfers.some((transfer) => transfer.expenseIds.includes("exp-1") && transfer.fromId === "carol")).toBe(true);
    expect(expensesInScope(trip, rows, new Set([disputeKey("exp-1", "bob"), disputeKey("exp-1", "carol")]))
      .some((item) => item.id === "exp-1")).toBe(false);
    // The original financial record and confirmed paid state are unchanged.
    expect(rows[0].shares[0].paid).toBe(true);
  });

  it("captures included expense versions, balances, assets, creator, expiry and transfers", () => {
    const { snapshot } = proposalFrom(baseExpenses());
    expect(snapshot).toMatchObject({
      tripId: "trip-1",
      creatorWallet: ALICE,
      createdAt: "2026-05-01T10:00:00.000Z",
      expiresAt: "2026-05-02T10:00:00.000Z",
      assets: ["native"],
    });
    expect(snapshot.expenses.map((e) => [e.id, e.version])).toEqual([
      ["exp-1", 3],
      ["exp-2", 7],
    ]);
    expect(snapshot.balances).toEqual([
      { asset: "native", memberId: "alice", name: "Alice", net: "40.0000000" },
      { asset: "native", memberId: "bob", name: "Bob", net: "-20.0000000" },
      { asset: "native", memberId: "carol", name: "Carol", net: "-20.0000000" },
    ]);
    expect(snapshot.transfers.map((t) => [t.fromId, t.toId, t.amount])).toEqual([
      ["bob", "alice", "20.0000000"],
      ["carol", "alice", "20.0000000"],
    ]);
    expect(snapshot.participants.map((p) => p.wallet)).toEqual([ALICE, BOB, CAROL]);
  });

  it("leaves out expenses with nothing owed", () => {
    const settled = expense("exp-2", {
      shares: expense("exp-2").shares.map((s) => ({ ...s, paid: true })),
    });
    const { snapshot } = proposalFrom([expense("exp-1"), settled]);
    expect(snapshot.expenses.map((e) => e.id)).toEqual(["exp-1"]);
  });

  it("hashes deterministically, independent of input order and key order", () => {
    const a = proposalFrom(baseExpenses());
    const b = proposalFrom([...baseExpenses()].reverse());
    expect(a.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(b.contentHash).toBe(a.contentHash);
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));

    const changed = proposalFrom([expense("exp-1", { totalAmount: "31", shares: [...expense("exp-1").shares.slice(0, 2), { memberId: "carol", name: "Carol", walletAddress: CAROL, amount: "11.0000000", paid: false }] }), expense("exp-2", { version: 7 })]);
    expect(changed.contentHash).not.toBe(a.contentHash);
  });

  it("puts a short reference in the memo that fits after the app's prefix", () => {
    const p = proposalFrom(baseExpenses());
    const memo = proposalMemo(p.contentHash);
    expect(memo).toBe(`SSP:${proposalReference(p.contentHash)}`);
    const full = `${MEMO_PREFIX}|${memo}`;
    expect(trimToMemoBytes(full)).toBe(full);
  });
});

describe("member confirmation", () => {
  it("is approved only once every participant approves", () => {
    const p = proposalFrom(baseExpenses());
    expect(evaluate(p, []).status).toBe("open");
    expect(evaluate(p, [respond(p, ALICE, "approve"), respond(p, BOB, "approve")])).toMatchObject({
      status: "open",
      pending: [expect.objectContaining({ wallet: CAROL })],
    });
    expect(evaluate(p, approvedBy(p)).status).toBe("approved");
  });

  it("records rejections and edit requests with their reasons; the latest answer counts", () => {
    const p = proposalFrom(baseExpenses());
    const rejected = evaluate(p, [...approvedBy(p).slice(0, 2), respond(p, CAROL, "reject", "Dinner was split wrong")]);
    expect(rejected.status).toBe("rejected");
    expect(rejected.rejections[0].reason).toBe("Dinner was split wrong");

    expect(evaluate(p, [respond(p, BOB, "request_edit", "Add the taxi")]).status).toBe("edit_requested");
    expect(evaluate(p, [respond(p, CAROL, "reject", "no"), ...approvedBy(p)]).status).toBe("approved");
  });

  it("requires a reason to reject or request an edit, and only from participants", () => {
    const p = proposalFrom(baseExpenses());
    const ev = evaluate(p, []);
    expect(validateResponse(p, ev, BOB, "reject", "  ")).toMatchObject({ ok: false });
    expect(validateResponse(p, ev, BOB, "request_edit", null)).toMatchObject({ ok: false });
    expect(validateResponse(p, ev, BOB, "reject", "wrong total")).toEqual({ ok: true, reason: "wrong total", memberId: "bob" });
    expect(validateResponse(p, ev, BOB, "approve", undefined)).toEqual({ ok: true, reason: null, memberId: "bob" });
    expect(validateResponse(p, ev, "GSTRANGER", "approve", null)).toMatchObject({ ok: false });
  });

  it("only counts answers given to this exact snapshot", () => {
    const p = proposalFrom(baseExpenses());
    const stale = approvedBy(p).map((r) => ({ ...r, contentHash: "0".repeat(64) }));
    expect(evaluate(p, stale)).toMatchObject({ status: "open", approvals: [] });
  });
});

describe("a material change invalidates approval", () => {
  const p = proposalFrom(baseExpenses());
  const approvals = approvedBy(p);

  it.each([
    ["an amount changes", [expense("exp-1", { totalAmount: "33" }), expense("exp-2", { version: 7 })], "amount_changed"],
    [
      "a share's amount changes",
      [expense("exp-1", { shares: expense("exp-1").shares.map((s) => (s.memberId === "bob" ? { ...s, amount: "12.0000000" } : s)) }), expense("exp-2")],
      "amount_changed",
    ],
    ["the payer changes", [expense("exp-1", { paidByMemberId: "bob" }), expense("exp-2")], "payer_changed"],
    ["the asset changes", [expense("exp-1", { settlementAsset: `USDC:${"G".padEnd(56, "A")}` }), expense("exp-2")], "asset_changed"],
    ["an expense is removed", [expense("exp-1")], "removed"],
    [
      "a payment is reverted",
      [expense("exp-1", { shares: expense("exp-1").shares.map((s) => (s.memberId === "alice" ? { ...s, paid: false } : s)) }), expense("exp-2")],
      "payment_reverted",
    ],
  ])("when %s", (_label, expenses, kind) => {
    const ev = evaluate(p, approvals, expenses as Expense[]);
    expect(ev.status).toBe("invalidated");
    expect(ev.approvals).toEqual([]);
    expect(ev.changes.map((c) => c.kind)).toContain(kind);
  });

  it("when an unpaid expense is added to the trip", () => {
    const withNew = { ...trip, expenseIds: [...trip.expenseIds, "exp-3"] };
    const changes = detectMaterialChanges(p.snapshot, withNew, [...baseExpenses(), expense("exp-3")]);
    expect(changes).toEqual([{ expenseId: "exp-3", kind: "added" }]);
  });

  it("but not when a share in it is paid — that is progress", () => {
    const progressed = [
      expense("exp-1", { version: 4, shares: expense("exp-1").shares.map((s) => (s.memberId === "bob" ? { ...s, paid: true, txHash: "a".repeat(64) } : s)) }),
      expense("exp-2", { version: 7 }),
    ];
    expect(evaluate(p, approvals, progressed).status).toBe("approved");
  });
});

describe("lifecycle", () => {
  it("expires, can be revoked or superseded, and detects a tampered snapshot", () => {
    const p = proposalFrom(baseExpenses());
    expect(evaluate(p, approvedBy(p), baseExpenses(), Date.parse(p.expiresAt)).status).toBe("expired");
    expect(evaluate({ ...p, status: "revoked" }, approvedBy(p)).status).toBe("revoked");
    expect(evaluate({ ...p, status: "superseded" }, approvedBy(p)).status).toBe("superseded");

    const tampered = { ...p, snapshot: { ...p.snapshot, transfers: p.snapshot.transfers.map((t) => ({ ...t, amount: "1.0000000" })) } };
    expect(evaluate(tampered, approvedBy(p))).toMatchObject({ status: "tampered", approvals: [] });
  });
});

describe("paying from a proposal", () => {
  const p = proposalFrom(baseExpenses());
  const bobToAlice = { fromId: "bob", toId: "alice", asset: "native", amount: "20.0000000" };

  it("is authorized for a transfer in an approved proposal, with its reference and memo", () => {
    const auth = authorizeProposalPayment(p, evaluate(p, approvedBy(p)), bobToAlice);
    expect(auth).toMatchObject({ ok: true, reference: proposalReference(p.contentHash), memo: proposalMemo(p.contentHash) });
    expect(proposalPaymentGate(p, evaluate(p, approvedBy(p)), bobToAlice)).toEqual({
      mode: "proposal",
      reference: proposalReference(p.contentHash),
      memo: proposalMemo(p.contentHash),
    });
  });

  it("cannot be authorized by an expired or revoked proposal", () => {
    const expired = evaluate(p, approvedBy(p), baseExpenses(), Date.parse(p.expiresAt) + 1);
    expect(authorizeProposalPayment(p, expired, bobToAlice)).toMatchObject({ ok: false, code: "EXPIRED" });

    const revoked = evaluate({ ...p, status: "revoked" }, approvedBy(p));
    expect(authorizeProposalPayment(p, revoked, bobToAlice)).toMatchObject({ ok: false, code: "REVOKED" });

    const superseded = evaluate({ ...p, status: "superseded" }, approvedBy(p));
    expect(authorizeProposalPayment(p, superseded, bobToAlice)).toMatchObject({ ok: false, code: "REVOKED" });

    expect(proposalPaymentGate(p, expired, bobToAlice)).toMatchObject({ mode: "direct", note: expect.stringMatching(/expired.*not covered/) });
  });

  it("cannot be authorized before every member approves, or after a material change", () => {
    expect(authorizeProposalPayment(p, evaluate(p, []), bobToAlice)).toMatchObject({ ok: false, code: "NOT_APPROVED" });
    expect(proposalPaymentGate(p, evaluate(p, []), bobToAlice)).toMatchObject({ mode: "blocked" });

    const changed = evaluate(p, approvedBy(p), [expense("exp-1", { totalAmount: "99" }), expense("exp-2")]);
    expect(authorizeProposalPayment(p, changed, bobToAlice)).toMatchObject({ ok: false, code: "INVALIDATED" });
  });

  it("only authorizes transfers that are actually in the snapshot", () => {
    const ev = evaluate(p, approvedBy(p));
    expect(authorizeProposalPayment(p, ev, { ...bobToAlice, amount: "25" })).toMatchObject({ ok: false, code: "NOT_IN_PROPOSAL" });
    expect(authorizeProposalPayment(p, ev, { ...bobToAlice, toId: "carol" })).toMatchObject({ ok: false, code: "NOT_IN_PROPOSAL" });
  });

  it("does not gate anything when there is no proposal", () => {
    expect(proposalPaymentGate(null, null, bobToAlice)).toEqual({ mode: "direct", note: null });
  });
});
