import { Money, STROOPS_PER_UNIT } from "@/lib/money";
import { apportionShares, type ParticipantWeight } from "@/lib/split/calculator";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { shareBalance, hasInstallments } from "@/lib/settlement/installments";
import type { Expense, SplitShare, Member, CorrectionType } from "@/types/expense";

export const MIN_AUDIT_REASON_LENGTH = 3;
export const MAX_AUDIT_REASON_LENGTH = 1000;

export interface ExpenseValidationResult {
  allowed: boolean;
  reason?: string;
}

export interface EffectiveMemberBalance {
  memberId: string;
  name: string;
  walletAddress?: string;
  paidAmount: Money;
  shareAmount: Money;
  netAmount: Money; // Positive = is owed, Negative = owes
}

export interface EffectiveExpenseSummary {
  originalExpense: Expense;
  isVoided: boolean;
  corrections: Expense[];
  effectiveTotalAmount: Money;
  effectiveShares: Array<{
    memberId: string;
    name: string;
    walletAddress?: string;
    originalAmount: Money;
    adjustedAmount: Money;
    paidAmount: Money;
    netBalance: Money;
  }>;
}

/**
 * Validates whether an audit reason satisfies audit trail constraints.
 */
export function validateAuditReason(reason: string | undefined | null): string {
  const trimmed = (reason ?? "").trim();
  if (trimmed.length < MIN_AUDIT_REASON_LENGTH) {
    throw new Error(`An audit reason of at least ${MIN_AUDIT_REASON_LENGTH} characters is required.`);
  }
  if (trimmed.length > MAX_AUDIT_REASON_LENGTH) {
    throw new Error(`Audit reason cannot exceed ${MAX_AUDIT_REASON_LENGTH} characters.`);
  }
  return trimmed;
}

/**
 * Checks if an expense has any on-chain settlement, paid shares, or installments.
 */
export function isExpenseSettledOrPartiallyPaid(expense: Expense): boolean {
  if (expense.settled) return true;
  return (expense.shares ?? []).some((share) => share.paid || hasInstallments(share));
}

/**
 * Checks whether an unsettled expense can be voided.
 */
export function canVoidExpense(
  expense: Expense,
  callerWallet?: string | null,
  isPrivilegedManager: boolean = false,
): ExpenseValidationResult {
  if (expense.voided) {
    return { allowed: false, reason: "This expense is already voided." };
  }

  if (isExpenseSettledOrPartiallyPaid(expense)) {
    return {
      allowed: false,
      reason: "Settled or partially settled expenses cannot be voided. Create a linked correction record instead.",
    };
  }

  if (callerWallet) {
    const normalizedCaller = callerWallet.trim().toUpperCase();
    const isPayer = expense.members.some(
      (m) => m.id === expense.paidByMemberId && m.walletAddress?.trim().toUpperCase() === normalizedCaller,
    );
    const isCreator = (expense as any).createdByWallet?.trim().toUpperCase() === normalizedCaller;

    if (!isPayer && !isCreator && !isPrivilegedManager) {
      return {
        allowed: false,
        reason: "Only the payer, creator, or a trip organizer can void this expense.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Checks whether a settled expense can be corrected via linked adjustment/offset.
 */
export function canCorrectExpense(
  expense: Expense,
  callerWallet?: string | null,
  isPrivilegedManager: boolean = false,
): ExpenseValidationResult {
  if (expense.voided) {
    return { allowed: false, reason: "Cannot correct a voided expense." };
  }

  if (!isExpenseSettledOrPartiallyPaid(expense)) {
    return {
      allowed: false,
      reason: "This expense is unsettled. Unsettled expenses can be edited or voided directly with an audit reason.",
    };
  }

  if (callerWallet) {
    const normalizedCaller = callerWallet.trim().toUpperCase();
    const isPayer = expense.members.some(
      (m) => m.id === expense.paidByMemberId && m.walletAddress?.trim().toUpperCase() === normalizedCaller,
    );
    const isCreator = (expense as any).createdByWallet?.trim().toUpperCase() === normalizedCaller;

    if (!isPayer && !isCreator && !isPrivilegedManager) {
      return {
        allowed: false,
        reason: "Only the payer, creator, or a trip organizer can create a linked correction.",
      };
    }
  }

  return { allowed: true };
}

/**
 * Builds a linked reversal expense for a settled expense.
 *
 * Invariant: Preserves the original expense completely (amount, shares, txProof).
 * Creates a linked reversal record where the original payer repays the settled
 * amounts back to the members who paid.
 */
export function buildLinkedReversal(input: {
  originalExpense: Expense;
  reason: string;
  actorWallet: string;
}): Expense {
  const auditReason = validateAuditReason(input.reason);
  const validation = canCorrectExpense(input.originalExpense, input.actorWallet, true);
  if (!validation.allowed) {
    throw new Error(validation.reason);
  }

  const orig = input.originalExpense;
  const originalPayer = orig.members.find((m) => m.id === orig.paidByMemberId);
  if (!originalPayer) {
    throw new Error("Original payer member not found.");
  }

  // Find all shares that were paid on-chain (either fully or partially via installments)
  const paidShares: Array<{ share: SplitShare; paidAmount: Money }> = [];
  let totalReversalStroops = 0n;

  for (const s of orig.shares) {
    if (s.memberId === orig.paidByMemberId) continue;
    const balance = shareBalance(s);
    if (balance.paidStroops > 0n) {
      const paidMoney = Money.fromStroops(balance.paidStroops);
      paidShares.push({ share: s, paidAmount: paidMoney });
      totalReversalStroops += balance.paidStroops;
    }
  }

  if (totalReversalStroops === 0n) {
    throw new Error("No paid shares exist to reverse on this expense.");
  }

  const totalReversalMoney = Money.fromStroops(totalReversalStroops);

  // In the reversal expense:
  // The original payer is the payer (reimbursing the group), and the members who paid receive their share back.
  // In the settlement graph, debtor owes creditor.
  // If Bob paid Alice 50 XLM in originalExpense:
  // Reversal has Alice as debtor, Bob as creditor.
  // In our schema: paidByMemberId is the creditor, shares are debtors.
  // To make Alice owe Bob 50 XLM, the reversal has paidByMemberId = Bob, share = Alice owes Bob 50 XLM!
  // If multiple members paid, we can construct the reversal with the primary member or construct
  // equal/custom offset shares.
  // For multi-member refunds where Alice owes multiple members:
  // We designate the reversal as:
  // paidByMemberId: originalPayer.id (Alice)
  // But wait: if Alice is paidByMemberId, shares owe Alice. That would make them pay Alice again!
  // Therefore, for Alice to owe Bob and Charlie:
  // Each member who paid is credited via an offset.
  // In our settlement engine, a correction with correctionType: 'reversal':
  // Bob is paidByMemberId, Alice has share = Bob's paid amount.
  // For multiple members, we generate shares where payer is Bob (if single) or
  // we record the reversal with the original payer and negative shares / inverse relationship.
  // Let's ensure compatibility with standard SplitShare:
  // If there's 1 paid member (most common case), payer = that member, share = Alice.
  // If there are multiple members, we make the reversal member the payer with highest paid share,
  // or create an adjustment where each member's debt is offset.
  // A clean universal pattern for reversal:
  // If 1 member paid: paidByMemberId is that member, shares is [{ memberId: Alice, amount: paidAmount }].
  // If multiple members paid: paidByMemberId is the member who paid the most, and shares represent the refund distribution.
  // Even cleaner:
  // Reversal expense sets `splitMode: "custom"`.
  // First paid member is payer, or original payer is payer with correctionType: 'reversal'.
  // Let's check how deriveRawDebts handles it:
  // If correctionType === 'reversal':
  // In deriveRawDebts, we can treat a reversal where paidByMemberId is the original payer
  // as an inverse refund (original payer owes the share members)!
  // That allows ONE clean reversal record where:
  // paidByMemberId: originalPayer.id (Alice)
  // shares: [{ memberId: Bob, amount: 50 }, { memberId: Charlie, amount: 50 }]
  // and in the debt graph, Alice owes Bob and Charlie!

  const reversalShares: SplitShare[] = paidShares.map(({ share, paidAmount }) => ({
    memberId: share.memberId,
    name: share.name,
    walletAddress: share.walletAddress,
    amount: paidAmount.format(7),
    paid: false,
  }));

  const reversalExpense: Expense = {
    id: crypto.randomUUID(),
    title: `[Reversal] ${orig.title}`,
    description: `Full reversal of expense "${orig.title}". Audit Reason: ${auditReason}`,
    totalAmount: totalReversalMoney.format(7),
    currency: orig.currency,
    settlementAsset: settlementAssetOf(orig),
    exchangeRate: orig.exchangeRate,
    exchangeRateTimestamp: orig.exchangeRateTimestamp,
    exchangeRateSource: orig.exchangeRateSource,
    category: orig.category,
    tags: orig.tags ? [...orig.tags, "reversal"] : ["reversal"],
    splitMode: orig.splitMode,
    paidByMemberId: orig.paidByMemberId,
    members: orig.members,
    shares: reversalShares,
    settled: false,
    version: 1,
    createdAt: new Date().toISOString(),
    correctionOfExpenseId: orig.id,
    correctionType: "reversal",
    correctionReason: auditReason,
  };

  return reversalExpense;
}

/**
 * Builds a linked adjustment expense with exact money arithmetic down to the stroop.
 */
export function buildLinkedAdjustment(input: {
  originalExpense: Expense;
  reason: string;
  adjustmentType: "adjustment" | "offset";
  actorWallet: string;
  title?: string;
  adjustedTotalAmount: string;
  newSplitMode?: "equal" | "custom";
  customWeights?: Record<string, number>;
}): Expense {
  const auditReason = validateAuditReason(input.reason);
  const validation = canCorrectExpense(input.originalExpense, input.actorWallet, true);
  if (!validation.allowed) {
    throw new Error(validation.reason);
  }

  const orig = input.originalExpense;
  const newTotalMoney = Money.tryParse(input.adjustedTotalAmount);
  if (!newTotalMoney || newTotalMoney.isNegative() || newTotalMoney.isZero()) {
    throw new Error("Adjusted total amount must be a positive number.");
  }

  const splitMode = input.newSplitMode ?? orig.splitMode;
  const participants: ParticipantWeight[] = orig.members.map((m) => ({
    id: m.id,
    weight: splitMode === "custom" ? (input.customWeights?.[m.id] ?? m.weight ?? 1) : 1,
  }));

  // Apportion revised shares with deterministic largest-remainder engine
  const targetShareMap = apportionShares(newTotalMoney, participants);

  // Compare against original shares to compute the delta
  // If revised share > original share: member owes more (+delta)
  // If revised share < original share: member is owed refund (-delta)
  const origShareMap = new Map<string, Money>();
  for (const s of orig.shares) {
    origShareMap.set(s.memberId, Money.parse(s.amount));
  }

  // Calculate payer original share: origTotal - sum(origNonPayerShares)
  const origTotal = Money.parse(orig.totalAmount);
  const origNonPayerSum = Money.sum(orig.shares.map((s) => s.amount));
  const origPayerShare = origTotal.minus(origNonPayerSum);
  origShareMap.set(orig.paidByMemberId, origPayerShare);

  const nonPayerMembers = orig.members.filter((m) => m.id !== orig.paidByMemberId);

  // Shares for the adjustment record represent the revised distribution
  const adjustmentShares: SplitShare[] = nonPayerMembers.map((m) => {
    const targetAmount = targetShareMap.get(m.id) ?? Money.zero();
    return {
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: targetAmount.format(7),
      paid: false,
    };
  });

  const adjustmentExpense: Expense = {
    id: crypto.randomUUID(),
    title: input.title?.trim() || `[Adjustment] ${orig.title}`,
    description: `Adjustment for "${orig.title}". Audit Reason: ${auditReason}`,
    totalAmount: newTotalMoney.format(7),
    currency: orig.currency,
    settlementAsset: settlementAssetOf(orig),
    exchangeRate: orig.exchangeRate,
    exchangeRateTimestamp: orig.exchangeRateTimestamp,
    exchangeRateSource: orig.exchangeRateSource,
    category: orig.category,
    tags: orig.tags ? [...orig.tags, "adjustment"] : ["adjustment"],
    splitMode,
    paidByMemberId: orig.paidByMemberId,
    members: orig.members,
    shares: adjustmentShares,
    settled: false,
    version: 1,
    createdAt: new Date().toISOString(),
    correctionOfExpenseId: orig.id,
    correctionType: input.adjustmentType,
    correctionReason: auditReason,
  };

  return adjustmentExpense;
}

/**
 * Computes effective balances for all participants across a set of expenses,
 * factoring in voided records, reversals, and linked adjustments.
 *
 * Invariants:
 * 1. Voided expenses contribute 0 to effective balances.
 * 2. On-chain proof and original amounts are preserved intact in history.
 * 3. Conservation: Sum of effective balances equals 0 exactly.
 * 4. Deterministic and repeatable under repeated corrections and chaining.
 */
export function calculateEffectiveExpenseBalances(
  expenses: Expense[],
  assetFilter?: string,
): Map<string, EffectiveMemberBalance> {
  const balanceMap = new Map<string, EffectiveMemberBalance>();

  const getOrCreate = (member: Member): EffectiveMemberBalance => {
    let entry = balanceMap.get(member.id);
    if (!entry) {
      entry = {
        memberId: member.id,
        name: member.name,
        walletAddress: member.walletAddress,
        paidAmount: Money.zero(),
        shareAmount: Money.zero(),
        netAmount: Money.zero(),
      };
      balanceMap.set(member.id, entry);
    }
    return entry;
  };

  for (const exp of expenses) {
    // Invariant 1: Voided expenses are completely excluded from balances
    if (exp.voided) continue;

    const asset = settlementAssetOf(exp);
    if (assetFilter && asset !== assetFilter) continue;

    const payer = exp.members.find((m) => m.id === exp.paidByMemberId);
    if (!payer) continue;

    // Track all members
    for (const m of exp.members) {
      getOrCreate(m);
    }

    const totalMoney = Money.tryParse(exp.totalAmount) ?? Money.zero();

    if (exp.correctionType === "reversal") {
      // Reversal: the original payer repays the share members
      // The payer's balance decreases by the reversal sum; each share member's balance increases
      for (const share of exp.shares) {
        const shareMoney = Money.tryParse(share.amount) ?? Money.zero();
        const debtor = getOrCreate({ id: share.memberId, name: share.name, walletAddress: share.walletAddress });
        const creditor = getOrCreate(payer);

        // Share member is refunded:
        debtor.netAmount = debtor.netAmount.plus(shareMoney);
        creditor.netAmount = creditor.netAmount.minus(shareMoney);
      }
    } else {
      // Standard expense or adjustment:
      // Payer paid totalMoney:
      const payerEntry = getOrCreate(payer);
      payerEntry.paidAmount = payerEntry.paidAmount.plus(totalMoney);
      payerEntry.netAmount = payerEntry.netAmount.plus(totalMoney);

      // Each share owes shareAmount:
      for (const share of exp.shares) {
        const shareMoney = Money.tryParse(share.amount) ?? Money.zero();
        const shareEntry = getOrCreate({ id: share.memberId, name: share.name, walletAddress: share.walletAddress });
        shareEntry.shareAmount = shareEntry.shareAmount.plus(shareMoney);
        shareEntry.netAmount = shareEntry.netAmount.minus(shareMoney);
      }

      // Payer's own share is total - sum(nonPayerShares):
      const nonPayerSum = Money.sum(exp.shares.map((s) => s.amount));
      const payerShare = totalMoney.minus(nonPayerSum);
      payerEntry.shareAmount = payerEntry.shareAmount.plus(payerShare);
      payerEntry.netAmount = payerEntry.netAmount.minus(payerShare);
    }
  }

  return balanceMap;
}

/**
 * Finds all linked corrections for a given expense, including repeated and chained corrections.
 */
export function getExpenseCorrections(
  expenseId: string,
  allExpenses: Expense[],
): Expense[] {
  const result: Expense[] = [];
  const visited = new Set<string>();

  const findChildren = (id: string) => {
    for (const e of allExpenses) {
      if (e.correctionOfExpenseId === id && !visited.has(e.id)) {
        visited.add(e.id);
        result.push(e);
        // Recurse to find chained corrections
        findChildren(e.id);
      }
    }
  };

  findChildren(expenseId);
  return result.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}
