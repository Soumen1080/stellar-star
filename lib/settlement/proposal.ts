/**
 * lib/settlement/proposal.ts — settlement proposals and member confirmation (#328).
 *
 * For larger groups, settlement starts from a frozen "proposed settlement":
 * one snapshot of exactly which expense versions, balances, assets and
 * transfers are on the table, which members then approve, reject (with a
 * reason) or send back for an edit.
 *
 * Pure: no I/O. Storage is in ./proposalQueries; every rule is here.
 *
 * Invariants:
 * 1. Deterministic: the snapshot is canonical (sorted, exact decimal strings)
 *    and its content hash is SHA-256 over canonical JSON, so the same inputs
 *    always produce the same hash on every client.
 * 2. Self-verifying: readers recompute the hash from the stored snapshot; a
 *    mismatch makes the proposal invalid, so a tampered snapshot cannot
 *    collect approvals.
 * 3. Approvals are bound to a hash. A response counts only for the exact
 *    snapshot it answered, and any material change to the included expenses
 *    (amounts, members, payer, asset, an expense added or removed, a payment
 *    reverted) invalidates the proposal and every approval with it. Paying a
 *    share is progress, not a change.
 * 4. Only an approved, unexpired, unrevoked proposal authorizes a payment, and
 *    only for a transfer it actually contains.
 */

import { hash } from "@stellar/stellar-sdk";
import { Money } from "@/lib/money";
import { computeNetBalances, computeNetPayments, type RawDebt } from "@/lib/settlement/simplify";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";

export const PROPOSAL_VERSION = 1;
export const DEFAULT_PROPOSAL_TTL_MS = 3 * 24 * 60 * 60 * 1000;
export const MIN_PROPOSAL_TTL_MS = 60 * 60 * 1000;
export const MAX_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;
export const MAX_REASON_LENGTH = 500;
export const PROPOSAL_MEMO_PREFIX = "SSP:";

export interface SnapshotShare {
  memberId: string;
  amount: string;
  paid: boolean;
}

export interface SnapshotExpense {
  id: string;
  version: number;
  asset: string;
  totalAmount: string;
  paidByMemberId: string;
  shares: SnapshotShare[];
}

export interface SnapshotBalance {
  asset: string;
  memberId: string;
  name: string;
  /** Positive: is owed. Negative: owes. Exact decimal string. */
  net: string;
}

export interface SnapshotTransfer {
  fromId: string;
  toId: string;
  from: string;
  to: string;
  fromWallet: string | null;
  toWallet: string | null;
  asset: string;
  amount: string;
  expenseIds: string[];
}

export interface SnapshotParticipant {
  memberId: string;
  name: string;
  wallet: string;
}

export interface ProposalSnapshot {
  v: typeof PROPOSAL_VERSION;
  tripId: string;
  creatorWallet: string;
  createdAt: string;
  expiresAt: string;
  assets: string[];
  expenses: SnapshotExpense[];
  balances: SnapshotBalance[];
  transfers: SnapshotTransfer[];
  /** Members whose balance is affected and who can sign in to confirm. */
  participants: SnapshotParticipant[];
}

export type ProposalDecision = "approve" | "reject" | "request_edit";

export interface ProposalResponse {
  memberId: string;
  wallet: string;
  decision: ProposalDecision;
  reason: string | null;
  contentHash: string;
  createdAt: string;
}

export type StoredProposalStatus = "open" | "revoked" | "superseded" | "invalidated";

export interface SettlementProposal {
  id: string;
  tripId: string;
  creatorWallet: string;
  contentHash: string;
  snapshot: ProposalSnapshot;
  status: StoredProposalStatus;
  expiresAt: string;
  revokedReason: string | null;
  createdAt: string;
}

// ─── Canonical form and hash ──────────────────────────────────────────────────

/** JSON with object keys sorted at every level, so key order never matters. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

export function proposalContentHash(snapshot: ProposalSnapshot): string {
  return Buffer.from(hash(Buffer.from(canonicalJson(snapshot), "utf8"))).toString("hex");
}

/** The short reference shown in the UI and carried in payment memos. */
export function proposalReference(contentHash: string): string {
  return contentHash.slice(0, 10).toUpperCase();
}

/** "SSP:<ref>" — 14 bytes, fits after the app's memo prefix in 28 bytes. */
export function proposalMemo(contentHash: string): string {
  return `${PROPOSAL_MEMO_PREFIX}${proposalReference(contentHash)}`;
}

// ─── Building a snapshot ──────────────────────────────────────────────────────

const exact = (amount: string) => Money.parse(amount).format();
const byString = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function disputeKey(expenseId: string, memberId: string): string {
  return `${expenseId}:${memberId}`;
}

function unpaidDebts(expenses: Expense[], disputedShares: ReadonlySet<string> = new Set()): RawDebt[] {
  const debts: RawDebt[] = [];
  for (const expense of expenses) {
    if (expense.voided) continue;
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    if (!payer) continue;
    for (const share of expense.shares) {
      if (share.paid || share.memberId === payer.id || disputedShares.has(disputeKey(expense.id, share.memberId))) continue;
      if (expense.correctionType === "reversal") {
        debts.push({
          expenseId: expense.id,
          fromId: payer.id,
          toId: share.memberId,
          from: payer.name,
          to: share.name,
          amount: share.amount,
          asset: settlementAssetOf(expense),
          fromWallet: payer.walletAddress,
          toWallet: share.walletAddress,
        });
      } else {
        debts.push({
          expenseId: expense.id,
          fromId: share.memberId,
          toId: payer.id,
          from: share.name,
          to: payer.name,
          amount: share.amount,
          asset: settlementAssetOf(expense),
          fromWallet: share.walletAddress,
          toWallet: payer.walletAddress,
        });
      }
    }
  }
  return debts;
}

/** The trip's expenses that still have something owed: what a proposal covers. */
export function expensesInScope(trip: Trip, expenses: Expense[], disputedShares: ReadonlySet<string> = new Set()): Expense[] {
  const ids = new Set(trip.expenseIds);
  return expenses.filter(
    (e) =>
      !e.voided &&
      ids.has(e.id) &&
      e.shares.some((s) => !s.paid && s.memberId !== e.paidByMemberId && !disputedShares.has(disputeKey(e.id, s.memberId))),
  );
}

export interface BuildSnapshotInput {
  trip: Trip;
  expenses: Expense[];
  disputedShares?: ReadonlySet<string>;
  creatorWallet: string;
  nowMs?: number;
  ttlMs?: number;
}

export function buildProposalSnapshot(input: BuildSnapshotInput): ProposalSnapshot {
  const ttl = input.ttlMs ?? DEFAULT_PROPOSAL_TTL_MS;
  if (!Number.isInteger(ttl) || ttl < MIN_PROPOSAL_TTL_MS || ttl > MAX_PROPOSAL_TTL_MS) {
    throw new RangeError("A proposal must expire between 1 hour and 14 days from now.");
  }
  const now = input.nowMs ?? Date.now();
  const disputedShares = input.disputedShares ?? new Set<string>();
  const scope = expensesInScope(input.trip, input.expenses, disputedShares).sort((a, b) => byString(a.id, b.id));

  const members = new Map(input.trip.members.map((m) => [m.id, m]));
  for (const expense of scope) for (const m of expense.members) if (!members.has(m.id)) members.set(m.id, m);

  const debts = unpaidDebts(scope, disputedShares);
  const netByAsset = computeNetBalances(debts);
  const balances: SnapshotBalance[] = [];
  for (const [asset, participants] of netByAsset) {
    for (const [memberId, entry] of participants) {
      if (entry.net.isZero()) continue;
      balances.push({ asset, memberId, name: members.get(memberId)?.name ?? entry.info.name, net: entry.net.format() });
    }
  }
  balances.sort((a, b) => byString(a.asset, b.asset) || byString(a.memberId, b.memberId));

  const transfers: SnapshotTransfer[] = computeNetPayments(debts)
    .map((p) => ({
      fromId: p.fromId ?? "",
      toId: p.toId ?? "",
      from: p.from,
      to: p.to,
      fromWallet: p.fromWallet ?? null,
      toWallet: p.toWallet ?? null,
      asset: p.asset,
      amount: exact(p.amount),
      expenseIds: [...new Set(p.settledDebts.map((d) => d.expenseId))].sort(byString),
    }))
    .sort((a, b) => byString(a.asset, b.asset) || byString(a.fromId, b.fromId) || byString(a.toId, b.toId));

  const participantIds = [...new Set(balances.map((b) => b.memberId))].sort(byString);
  const participants = participantIds
    .map((memberId) => members.get(memberId))
    .filter((m): m is NonNullable<typeof m> => !!m?.walletAddress)
    .map((m) => ({ memberId: m.id, name: m.name, wallet: m.walletAddress! }));

  return {
    v: PROPOSAL_VERSION,
    tripId: input.trip.id,
    creatorWallet: input.creatorWallet,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttl).toISOString(),
    assets: [...new Set(balances.map((b) => b.asset))].sort(byString),
    expenses: scope.map((e) => ({
      id: e.id,
      version: e.version ?? 1,
      asset: settlementAssetOf(e),
      totalAmount: exact(e.totalAmount),
      paidByMemberId: e.paidByMemberId,
      shares: e.shares
        .map((s) => ({ memberId: s.memberId, amount: exact(s.amount), paid: s.paid }))
        .sort((a, b) => byString(a.memberId, b.memberId)),
    })),
    balances,
    transfers,
    participants,
  };
}

// ─── Material changes ─────────────────────────────────────────────────────────

export interface MaterialChange {
  expenseId: string;
  kind: "removed" | "added" | "amount_changed" | "members_changed" | "payer_changed" | "asset_changed" | "payment_reverted" | "disputed";
}

/**
 * What changed, since the snapshot, in a way that changes who owes whom.
 * A share moving from unpaid to paid is settlement progress and not listed.
 */
export function detectMaterialChanges(snapshot: ProposalSnapshot, trip: Trip, expenses: Expense[]): MaterialChange[] {
  const changes: MaterialChange[] = [];
  const current = new Map(expenses.filter((e) => trip.expenseIds.includes(e.id)).map((e) => [e.id, e]));
  const included = new Set(snapshot.expenses.map((e) => e.id));

  for (const frozen of snapshot.expenses) {
    const now = current.get(frozen.id);
    if (!now) {
      changes.push({ expenseId: frozen.id, kind: "removed" });
      continue;
    }
    if (settlementAssetOf(now) !== frozen.asset) changes.push({ expenseId: frozen.id, kind: "asset_changed" });
    if (now.paidByMemberId !== frozen.paidByMemberId) changes.push({ expenseId: frozen.id, kind: "payer_changed" });
    if (!Money.parse(now.totalAmount).equals(frozen.totalAmount)) {
      changes.push({ expenseId: frozen.id, kind: "amount_changed" });
    }

    const shares = new Map(now.shares.map((s) => [s.memberId, s]));
    if (shares.size !== frozen.shares.length || frozen.shares.some((s) => !shares.has(s.memberId))) {
      changes.push({ expenseId: frozen.id, kind: "members_changed" });
      continue;
    }
    if (frozen.shares.some((s) => !Money.parse(shares.get(s.memberId)!.amount).equals(s.amount))) {
      changes.push({ expenseId: frozen.id, kind: "amount_changed" });
    }
    if (frozen.shares.some((s) => s.paid && !shares.get(s.memberId)!.paid)) {
      changes.push({ expenseId: frozen.id, kind: "payment_reverted" });
    }
  }

  for (const expense of expensesInScope(trip, expenses)) {
    if (!included.has(expense.id)) changes.push({ expenseId: expense.id, kind: "added" });
  }

  const seen = new Set<string>();
  return changes.filter((c) => {
    const key = `${c.expenseId}:${c.kind}`;
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

// ─── Status ───────────────────────────────────────────────────────────────────

export type ProposalStatus =
  | "open"
  | "approved"
  | "rejected"
  | "edit_requested"
  | "expired"
  | "revoked"
  | "superseded"
  | "invalidated"
  | "tampered";

export interface ProposalEvaluation {
  status: ProposalStatus;
  reference: string;
  approvals: SnapshotParticipant[];
  pending: SnapshotParticipant[];
  rejections: ProposalResponse[];
  editRequests: ProposalResponse[];
  changes: MaterialChange[];
}

/** Each member's latest response that answered this exact snapshot. */
export function latestResponses(contentHash: string, responses: ProposalResponse[]): Map<string, ProposalResponse> {
  const latest = new Map<string, ProposalResponse>();
  for (const r of [...responses].sort((a, b) => byString(a.createdAt, b.createdAt))) {
    if (r.contentHash !== contentHash) continue;
    latest.set(r.wallet, r);
  }
  return latest;
}

export function evaluateProposal(
  proposal: SettlementProposal,
  responses: ProposalResponse[],
  context: { nowMs?: number; trip: Trip; expenses: Expense[]; disputedShares?: ReadonlySet<string> },
): ProposalEvaluation {
  const reference = proposalReference(proposal.contentHash);
  const snapshot = proposal.snapshot;
  const participants = snapshot.participants ?? [];
  const latest = latestResponses(proposal.contentHash, responses);
  const fromParticipants = (r: ProposalResponse) => participants.some((p) => p.wallet === r.wallet);

  const approvals = participants.filter((p) => latest.get(p.wallet)?.decision === "approve");
  const pending = participants.filter((p) => !latest.has(p.wallet));
  const rejections = [...latest.values()].filter((r) => r.decision === "reject" && fromParticipants(r));
  const editRequests = [...latest.values()].filter((r) => r.decision === "request_edit" && fromParticipants(r));
  const base = { reference, approvals, pending, rejections, editRequests };

  if (proposalContentHash(snapshot) !== proposal.contentHash) {
    return { ...base, approvals: [], status: "tampered", changes: [] };
  }
  if (proposal.status === "revoked") return { ...base, status: "revoked", changes: [] };
  if (proposal.status === "superseded") return { ...base, status: "superseded", changes: [] };

  const changes = detectMaterialChanges(snapshot, context.trip, context.expenses);
  for (const item of snapshot.expenses) {
    if (item.shares.some((share) => !share.paid && context.disputedShares?.has(disputeKey(item.id, share.memberId)))) {
      changes.push({ expenseId: item.id, kind: "disputed" });
    }
  }
  if (proposal.status === "invalidated" || changes.length > 0) {
    // A material change voids every approval given so far.
    return { ...base, approvals: [], status: "invalidated", changes };
  }
  if ((context.nowMs ?? Date.now()) >= Date.parse(proposal.expiresAt)) {
    return { ...base, status: "expired", changes };
  }
  if (rejections.length > 0) return { ...base, status: "rejected", changes };
  if (editRequests.length > 0) return { ...base, status: "edit_requested", changes };
  if (participants.length > 0 && approvals.length === participants.length) {
    return { ...base, status: "approved", changes };
  }
  return { ...base, status: "open", changes };
}

// ─── Responding and paying ────────────────────────────────────────────────────

export type ResponseValidation =
  | { ok: true; reason: string | null; memberId: string }
  | { ok: false; message: string };

export function validateResponse(
  proposal: SettlementProposal,
  evaluation: ProposalEvaluation,
  wallet: string,
  decision: ProposalDecision,
  rawReason: string | null | undefined,
): ResponseValidation {
  const participant = proposal.snapshot.participants.find((p) => p.wallet === wallet);
  if (!participant) return { ok: false, message: "Only members whose balance is in this proposal can respond." };
  if (!["open", "approved", "rejected", "edit_requested"].includes(evaluation.status)) {
    return { ok: false, message: `This proposal is ${evaluation.status.replace("_", " ")} and can no longer be answered.` };
  }
  const reason = (rawReason ?? "").trim();
  if (decision !== "approve" && !reason) {
    return { ok: false, message: decision === "reject" ? "Say why you are rejecting it." : "Say what should change." };
  }
  if (reason.length > MAX_REASON_LENGTH) return { ok: false, message: "Keep the reason to 500 characters." };
  return { ok: true, reason: reason || null, memberId: participant.memberId };
}

export type PaymentAuthorization =
  | { ok: true; reference: string; memo: string; transfer: SnapshotTransfer }
  | { ok: false; code: "NOT_APPROVED" | "EXPIRED" | "REVOKED" | "INVALIDATED" | "NOT_IN_PROPOSAL"; message: string };

/**
 * Whether a payment may proceed under a proposal. Anything but an approved,
 * live proposal — expired, revoked, superseded, invalidated, tampered, or
 * still awaiting answers — authorizes nothing.
 */
export function authorizeProposalPayment(
  proposal: SettlementProposal,
  evaluation: ProposalEvaluation,
  transfer: Pick<SnapshotTransfer, "fromId" | "toId" | "asset" | "amount">,
): PaymentAuthorization {
  const ref = evaluation.reference;
  switch (evaluation.status) {
    case "approved":
      break;
    case "expired":
      return { ok: false, code: "EXPIRED", message: `Proposal ${ref} has expired. Propose the settlement again.` };
    case "revoked":
    case "superseded":
      return { ok: false, code: "REVOKED", message: `Proposal ${ref} was ${evaluation.status}; it cannot authorize payments.` };
    case "invalidated":
    case "tampered":
      return {
        ok: false,
        code: "INVALIDATED",
        message: `Expenses changed since proposal ${ref}, so its approvals no longer count. Propose again.`,
      };
    default:
      return { ok: false, code: "NOT_APPROVED", message: `Proposal ${ref} is not approved by every member yet.` };
  }

  const match = proposal.snapshot.transfers.find(
    (t) =>
      t.fromId === transfer.fromId &&
      t.toId === transfer.toId &&
      t.asset === transfer.asset &&
      Money.parse(t.amount).equals(transfer.amount),
  );
  if (!match) {
    return { ok: false, code: "NOT_IN_PROPOSAL", message: `This payment is not one of the transfers in proposal ${ref}.` };
  }
  return { ok: true, reference: ref, memo: proposalMemo(proposal.contentHash), transfer: match };
}

export type ProposalPaymentGate =
  | { mode: "proposal"; reference: string; memo: string }
  | { mode: "blocked"; reference: string; message: string }
  | { mode: "direct"; note: string | null };

/**
 * How a settlement row may be paid given the trip's latest proposal:
 *  - approved and the transfer is in it: pay *from* the proposal (its
 *    reference in the UI and the memo);
 *  - still awaiting agreement: wait, since members are deciding what to pay;
 *  - expired, revoked, superseded, invalidated or rejected: the proposal
 *    authorizes nothing, and the payment proceeds without it.
 */
export function proposalPaymentGate(
  proposal: SettlementProposal | null,
  evaluation: ProposalEvaluation | null,
  transfer: Pick<SnapshotTransfer, "fromId" | "toId" | "asset" | "amount">,
): ProposalPaymentGate {
  if (!proposal || !evaluation) return { mode: "direct", note: null };
  const ref = evaluation.reference;

  if (evaluation.status === "open" || evaluation.status === "edit_requested") {
    return {
      mode: "blocked",
      reference: ref,
      message: `Waiting for every member to approve proposal ${ref} before payments begin.`,
    };
  }

  const authorization = authorizeProposalPayment(proposal, evaluation, transfer);
  if (authorization.ok) return { mode: "proposal", reference: ref, memo: authorization.memo };
  return {
    mode: "direct",
    note: `${authorization.message} This payment is not covered by it.`,
  };
}
