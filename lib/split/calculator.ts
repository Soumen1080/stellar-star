import { StrKey } from "@stellar/stellar-sdk";
import type { Member, SplitShare } from "@/types/expense";
import { Money, STROOPS_PER_UNIT, divideBigInt } from "@/lib/money";

export function calculateEqualSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
): SplitShare[] {
  if (members.length === 0) return [];

  const nonPayers = members.filter((m) => m.id !== paidByMemberId);
  if (nonPayers.length === 0) return [];

  const totalMoney = totalXLM instanceof Money ? totalXLM : Money.parse(totalXLM);
  const totalMembersBig = BigInt(members.length);
  const perHeadStroops = totalMoney.stroops / totalMembersBig;

  const shares: SplitShare[] = [];
  let accumulatedStroops = 0n;

  // Non-payer total target in stroops
  const nonPayerCountBig = BigInt(nonPayers.length);
  // Total expected from non-payers is total - payer_share
  const payerShareStroops = perHeadStroops;
  const totalNonPayerTargetStroops = totalMoney.stroops - payerShareStroops;

  nonPayers.forEach((m, i) => {
    const isLast = i === nonPayers.length - 1;
    let shareStroops: bigint;

    if (isLast) {
      shareStroops = totalNonPayerTargetStroops - accumulatedStroops;
    } else {
      shareStroops = perHeadStroops;
    }

    if (shareStroops < 0n) shareStroops = 0n;
    accumulatedStroops += shareStroops;

    shares.push({
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: Money.fromStroops(shareStroops).format(7),
      paid: false,
    });
  });

  return shares;
}

export function calculateCustomSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
): SplitShare[] {
  if (members.length === 0) return [];

  const nonPayers = members.filter((m) => m.id !== paidByMemberId);
  if (nonPayers.length === 0) return [];

  const totalWeight = members.reduce((s, m) => s + (m.weight ?? 1), 0);
  if (totalWeight <= 0) return [];

  const totalMoney = totalXLM instanceof Money ? totalXLM : Money.parse(totalXLM);
  const totalWeightBig = BigInt(Math.round(totalWeight * 1_000_000));

  const nonPayerWeight = nonPayers.reduce((s, m) => s + (m.weight ?? 1), 0);
  const nonPayerWeightBig = BigInt(Math.round(nonPayerWeight * 1_000_000));
  const totalNonPayerTargetStroops = divideBigInt(
    totalMoney.stroops * nonPayerWeightBig,
    totalWeightBig,
    "half_up",
  );

  const shares: SplitShare[] = [];
  let accumulatedStroops = 0n;

  nonPayers.forEach((m, i) => {
    const isLast = i === nonPayers.length - 1;
    const weight = m.weight ?? 1;
    const weightBig = BigInt(Math.round(weight * 1_000_000));

    let shareStroops: bigint;
    if (isLast) {
      shareStroops = totalNonPayerTargetStroops - accumulatedStroops;
    } else {
      shareStroops = (totalMoney.stroops * weightBig) / totalWeightBig;
    }

    if (shareStroops < 0n) shareStroops = 0n;
    accumulatedStroops += shareStroops;

    shares.push({
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: Money.fromStroops(shareStroops).format(7),
      paid: false,
    });
  });

  return shares;
}

export function calculateSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
  mode: "equal" | "custom",
): SplitShare[] {
  return mode === "custom"
    ? calculateCustomSplit(totalXLM, members, paidByMemberId)
    : calculateEqualSplit(totalXLM, members, paidByMemberId);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export function isValidXLMAmount(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("-")) return false;

  // Maximum meaningful precision is 7 decimal places
  const dotIndex = trimmed.indexOf(".");
  if (dotIndex !== -1 && trimmed.length - dotIndex - 1 > 7) return false;

  const parsed = Money.tryParse(trimmed);
  if (!parsed || parsed.isNegative() || parsed.isZero()) return false;

  // Max 100 million XLM
  const maxAllowed = 100_000_000n * STROOPS_PER_UNIT;
  return parsed.stroops <= maxAllowed;
}

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

/**
 * Detects members sharing the same Stellar wallet address, comparing
 * trimmed + uppercased values. Only syntactically valid addresses are
 * considered — invalid ones are reported separately by field-level checks.
 * Returns a map of member index -> error message, flagging every member
 * involved in a collision (not just the second occurrence).
 */
export function findDuplicateWalletErrors(
  addresses: Array<string | undefined>,
): Record<number, string> {
  const seen = new Map<string, number>();
  const errors: Record<number, string> = {};

  addresses.forEach((address, index) => {
    const raw = address?.trim();
    if (!raw || !isValidStellarAddress(raw)) return;

    const normalised = raw.toUpperCase();
    const firstIndex = seen.get(normalised);
    if (firstIndex === undefined) {
      seen.set(normalised, index);
      return;
    }

    errors[index] = `Duplicate wallet address — already used by member ${firstIndex + 1}.`;
    if (!errors[firstIndex]) {
      errors[firstIndex] = `Duplicate wallet address — also used by member ${index + 1}.`;
    }
  });

  return errors;
}
