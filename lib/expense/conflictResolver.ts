/**
 * lib/expense/conflictResolver.ts
 *
 * Conflict Detection & 3-Way Merge Engine for Concurrent Expense Edits.
 *
 * Invariants:
 * 1. No committed edit is silently discarded. Either it applies, or the user is told it could not.
 * 2. A settled share is never modified by conflict resolution (money has moved).
 * 3. Post-merge, sum(shares) == total strictly holds.
 * 4. An expense never renders in a state that never existed on the server.
 * 5. Convergence: all clients observing the same event sequence reach identical state.
 */

import type { Expense, Member, SplitMode, SplitShare } from "@/types/expense";
import { calculateEqualSplit, calculateCustomSplit } from "@/lib/split/calculator";

export interface ConflictDetails {
  fields: string[];
  reason: string;
  serverExpense: Expense;
  proposedUpdates: Partial<Expense>;
}

export type MergeResult =
  | { success: true; merged: Expense; autoMerged: boolean }
  | { success: false; conflict: ConflictDetails };

export class ExpenseConflictError extends Error {
  readonly code = "CONCURRENT_MODIFICATION";
  readonly serverExpense: Expense;
  readonly conflicts: string[];
  readonly reason: string;

  constructor(conflict: ConflictDetails) {
    super(conflict.reason);
    this.name = "ExpenseConflictError";
    this.serverExpense = conflict.serverExpense;
    this.conflicts = conflict.fields;
    this.reason = conflict.reason;
  }
}

function toXLM(n: number): string {
  return n.toFixed(7);
}

/**
 * Recomputes shares for an expense while strictly preserving all settled shares (Invariant 2 & 3).
 *
 * Settled shares (paid: true, txHash) cannot be modified because real XLM has moved.
 * The remaining unpaid amount (total - settledAmount) is re-apportioned among the
 * remaining unpaid members according to splitMode.
 */
export function recomputeSharesWithSettled(
  totalAmountStr: string,
  members: Member[],
  paidByMemberId: string,
  splitMode: SplitMode,
  existingShares: SplitShare[] = [],
): SplitShare[] {
  const totalAmount = parseFloat(totalAmountStr);
  if (Number.isNaN(totalAmount) || totalAmount < 0 || members.length === 0) {
    return [];
  }

  // 1. Extract settled shares and their total
  const settledShares = existingShares.filter((s) => s.paid);
  const settledTotal = settledShares.reduce((sum, s) => sum + parseFloat(s.amount), 0);

  // If total is less than what has already been settled, clamp unpaid to 0
  const unpaidTarget = Math.max(0, totalAmount - settledTotal);

  // 2. Identify unpaid members (members who do not have a settled share)
  const settledMemberIds = new Set(settledShares.map((s) => s.memberId));
  const unpaidMembers = members.filter((m) => !settledMemberIds.has(m.id));

  // If all members are settled or no unpaid members exist, return settled shares
  if (unpaidMembers.length === 0) {
    return settledShares;
  }

  // 3. Compute unpaid split for unpaid non-payers
  let newUnpaidShares: SplitShare[] = [];
  if (unpaidTarget > 0) {
    if (splitMode === "custom") {
      newUnpaidShares = calculateCustomSplit(unpaidTarget, unpaidMembers, paidByMemberId);
    } else {
      newUnpaidShares = calculateEqualSplit(unpaidTarget, unpaidMembers, paidByMemberId);
    }
  } else {
    // Zero unpaid amount: create 0-amount shares for non-payers
    const unpaidNonPayers = unpaidMembers.filter((m) => m.id !== paidByMemberId);
    newUnpaidShares = unpaidNonPayers.map((m) => ({
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: toXLM(0),
      paid: false,
    }));
  }

  // 4. Combine settled shares and new unpaid shares
  // Preserve order based on member list
  const memberOrder = new Map(members.map((m, index) => [m.id, index]));
  const allShares = [...settledShares, ...newUnpaidShares];

  allShares.sort((a, b) => (memberOrder.get(a.memberId) ?? 999) - (memberOrder.get(b.memberId) ?? 999));

  return allShares;
}

/**
 * Performs a 3-way merge between baseExpense (at read time), serverExpense (current DB state),
 * and proposedUpdates from the local user edit.
 */
export function mergeExpenseUpdates(
  baseExpense: Expense,
  serverExpense: Expense,
  proposedUpdates: Partial<Expense>,
): MergeResult {
  // If server expense has not changed from base, proposed updates apply directly
  if (
    serverExpense.version !== undefined &&
    baseExpense.version !== undefined &&
    serverExpense.version === baseExpense.version
  ) {
    const updatedTitle = proposedUpdates.title ?? baseExpense.title;
    const updatedDescription =
      proposedUpdates.description !== undefined ? proposedUpdates.description : baseExpense.description;
    const updatedTotal = proposedUpdates.totalAmount ?? baseExpense.totalAmount;
    const updatedSplitMode = proposedUpdates.splitMode ?? baseExpense.splitMode;
    const updatedPaidBy = proposedUpdates.paidByMemberId ?? baseExpense.paidByMemberId;
    const updatedMembers = proposedUpdates.members ?? baseExpense.members;

    const sharesNeedRecompute =
      proposedUpdates.totalAmount !== undefined ||
      proposedUpdates.members !== undefined ||
      proposedUpdates.splitMode !== undefined ||
      proposedUpdates.paidByMemberId !== undefined;

    const updatedShares = sharesNeedRecompute
      ? recomputeSharesWithSettled(
          updatedTotal,
          updatedMembers,
          updatedPaidBy,
          updatedSplitMode,
          baseExpense.shares,
        )
      : (proposedUpdates.shares ?? baseExpense.shares);

    const settled = updatedShares.length > 0 && updatedShares.every((s) => s.paid);

    const merged: Expense = {
      ...baseExpense,
      title: updatedTitle,
      description: updatedDescription,
      totalAmount: updatedTotal,
      splitMode: updatedSplitMode,
      paidByMemberId: updatedPaidBy,
      members: updatedMembers,
      shares: updatedShares,
      settled,
      version: (serverExpense.version ?? 1) + 1,
      updatedAt: new Date().toISOString(),
    };

    return { success: true, merged, autoMerged: false };
  }

  // Server has concurrent changes! Detect field changes from base.
  const clientModified = new Set<string>();
  const serverModified = new Set<string>();

  // Check scalar fields
  if (proposedUpdates.title !== undefined && proposedUpdates.title !== baseExpense.title) {
    clientModified.add("title");
  }
  if (serverExpense.title !== baseExpense.title) {
    serverModified.add("title");
  }

  if (
    proposedUpdates.description !== undefined &&
    proposedUpdates.description !== baseExpense.description
  ) {
    clientModified.add("description");
  }
  if (serverExpense.description !== baseExpense.description) {
    serverModified.add("description");
  }

  if (
    proposedUpdates.totalAmount !== undefined &&
    proposedUpdates.totalAmount !== baseExpense.totalAmount
  ) {
    clientModified.add("totalAmount");
  }
  if (serverExpense.totalAmount !== baseExpense.totalAmount) {
    serverModified.add("totalAmount");
  }

  if (
    proposedUpdates.splitMode !== undefined &&
    proposedUpdates.splitMode !== baseExpense.splitMode
  ) {
    clientModified.add("splitMode");
  }
  if (serverExpense.splitMode !== baseExpense.splitMode) {
    serverModified.add("splitMode");
  }

  if (
    proposedUpdates.paidByMemberId !== undefined &&
    proposedUpdates.paidByMemberId !== baseExpense.paidByMemberId
  ) {
    clientModified.add("paidByMemberId");
  }
  if (serverExpense.paidByMemberId !== baseExpense.paidByMemberId) {
    serverModified.add("paidByMemberId");
  }

  // Check members
  const proposedMembers = proposedUpdates.members;
  if (
    proposedMembers !== undefined &&
    JSON.stringify(proposedMembers) !== JSON.stringify(baseExpense.members)
  ) {
    clientModified.add("members");
  }
  if (JSON.stringify(serverExpense.members) !== JSON.stringify(baseExpense.members)) {
    serverModified.add("members");
  }

  // Detect direct hard conflicts where both modified the same field to different values
  const conflictingFields: string[] = [];

  if (clientModified.has("title") && serverModified.has("title")) {
    if (proposedUpdates.title !== serverExpense.title) conflictingFields.push("title");
  }

  if (clientModified.has("description") && serverModified.has("description")) {
    if (proposedUpdates.description !== serverExpense.description) conflictingFields.push("description");
  }

  if (clientModified.has("totalAmount") && serverModified.has("totalAmount")) {
    if (proposedUpdates.totalAmount !== serverExpense.totalAmount) conflictingFields.push("totalAmount");
  }

  if (clientModified.has("splitMode") && serverModified.has("splitMode")) {
    if (proposedUpdates.splitMode !== serverExpense.splitMode) conflictingFields.push("splitMode");
  }

  if (clientModified.has("paidByMemberId") && serverModified.has("paidByMemberId")) {
    if (proposedUpdates.paidByMemberId !== serverExpense.paidByMemberId) conflictingFields.push("paidByMemberId");
  }

  // If there are direct collisions on scalar fields, reject with conflict details (Invariant 1)
  if (conflictingFields.length > 0) {
    return {
      success: false,
      conflict: {
        fields: conflictingFields,
        reason: `Conflict on ${conflictingFields.join(", ")}: Another member modified this expense simultaneously.`,
        serverExpense,
        proposedUpdates,
      },
    };
  }

  // Ensure settled shares are not violated (Invariant 2)
  const settledShares = serverExpense.shares.filter((s) => s.paid);
  const settledTotal = settledShares.reduce((sum, s) => sum + parseFloat(s.amount), 0);

  const effectiveTotalAmountStr = clientModified.has("totalAmount")
    ? proposedUpdates.totalAmount!
    : serverExpense.totalAmount;
  const effectiveTotalAmount = parseFloat(effectiveTotalAmountStr);

  if (effectiveTotalAmount < settledTotal) {
    return {
      success: false,
      conflict: {
        fields: ["totalAmount"],
        reason: `Cannot reduce total to ${effectiveTotalAmountStr} XLM because ${toXLM(settledTotal)} XLM has already been settled on-chain.`,
        serverExpense,
        proposedUpdates,
      },
    };
  }

  // Merge members
  let mergedMembers = [...serverExpense.members];
  if (clientModified.has("members") && proposedMembers) {
    // Check if client deleted a member who has a settled share
    for (const settledShare of settledShares) {
      const existsInProposed = proposedMembers.some((m) => m.id === settledShare.memberId);
      if (!existsInProposed) {
        return {
          success: false,
          conflict: {
            fields: ["members"],
            reason: `Cannot remove member "${settledShare.name}" because their share was already settled on-chain.`,
            serverExpense,
            proposedUpdates,
          },
        };
      }
    }

    // Merge member additions / removals
    const baseMemberIds = new Set(baseExpense.members.map((m) => m.id));
    const proposedMemberIds = new Set(proposedMembers.map((m) => m.id));
    const serverMemberIds = new Set(serverExpense.members.map((m) => m.id));

    // Members added by client
    const clientAdded = proposedMembers.filter((m) => !baseMemberIds.has(m.id));
    // Members removed by client
    const clientRemovedIds = new Set(
      baseExpense.members.filter((m) => !proposedMemberIds.has(m.id)).map((m) => m.id),
    );

    // Apply client additions
    for (const added of clientAdded) {
      if (!serverMemberIds.has(added.id)) {
        mergedMembers.push(added);
      }
    }

    // Apply client removals (only if not settled)
    mergedMembers = mergedMembers.filter(
      (m) => !clientRemovedIds.has(m.id) || settledShares.some((s) => s.memberId === m.id),
    );
  }

  const effectiveTitle = clientModified.has("title") ? proposedUpdates.title! : serverExpense.title;
  const effectiveDescription = clientModified.has("description")
    ? proposedUpdates.description
    : serverExpense.description;
  const effectiveSplitMode = clientModified.has("splitMode")
    ? proposedUpdates.splitMode!
    : serverExpense.splitMode;
  const effectivePaidByMemberId = clientModified.has("paidByMemberId")
    ? proposedUpdates.paidByMemberId!
    : serverExpense.paidByMemberId;

  // Recompute shares over merged members & amount (Invariant 3)
  const mergedShares = recomputeSharesWithSettled(
    effectiveTotalAmountStr,
    mergedMembers,
    effectivePaidByMemberId,
    effectiveSplitMode,
    serverExpense.shares,
  );

  const settled = mergedShares.length > 0 && mergedShares.every((s) => s.paid);

  const merged: Expense = {
    ...serverExpense,
    title: effectiveTitle,
    description: effectiveDescription,
    totalAmount: effectiveTotalAmountStr,
    splitMode: effectiveSplitMode,
    paidByMemberId: effectivePaidByMemberId,
    members: mergedMembers,
    shares: mergedShares,
    settled,
    version: (serverExpense.version ?? 1) + 1,
    updatedAt: new Date().toISOString(),
  };

  return { success: true, merged, autoMerged: true };
}
