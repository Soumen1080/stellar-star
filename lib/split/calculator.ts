import { StrKey } from "@stellar/stellar-sdk";
import type { Member, SplitMode, SplitShare } from "@/types/expense";
import { Money, STROOPS_PER_UNIT } from "@/lib/money";

export interface ParticipantWeight {
  id: string;
  weight: number;
}

/**
 * Normalizes floating/decimal weights to exact non-negative integer scale.
 * Eliminates IEEE-754 precision drift for fractional weights (e.g. 0.333, 1.5, 0.1).
 */
function scaleWeight(w: number): bigint {
  if (!Number.isFinite(w) || w <= 0) return 0n;
  const str = w.toString();
  const dot = str.indexOf(".");
  if (dot === -1) {
    return BigInt(str) * 10_000_000n;
  }
  const decimals = str.length - dot - 1;
  const intVal = BigInt(str.replace(".", ""));
  if (decimals <= 7) {
    return intVal * (10n ** BigInt(7 - decimals));
  }
  // If more than 7 decimals, truncate to 7 places
  const factor = 10n ** BigInt(decimals - 7);
  return intVal / factor;
}

/**
 * Deterministic Largest Remainder (Hamilton / Hare-Niemeyer) Apportionment Engine.
 *
 * Invariants:
 * 1. sum(shares) == total exactly down to the individual stroop.
 * 2. No share is negative.
 * 3. Equal weights produce shares differing by at most 1 minor unit (1 stroop).
 * 4. Deterministic and independent of input array ordering (canonical ID tie-breaking).
 * 5. Zero-weight members receive exactly 0 stroops and do not perturb other members' shares.
 */
export function apportionShares(
  total: Money,
  participants: ParticipantWeight[],
): Map<string, Money> {
  const result = new Map<string, Money>();
  if (participants.length === 0) return result;

  const totalStroops = total.stroops;
  if (totalStroops === 0n) {
    for (const p of participants) {
      result.set(p.id, Money.zero());
    }
    return result;
  }

  // Scale weights
  const scaledWeights = participants.map((p) => ({
    id: p.id,
    weightBig: scaleWeight(p.weight),
  }));

  const totalWeightBig = scaledWeights.reduce((sum, p) => sum + p.weightBig, 0n);

  // If all weights are zero, fallback to equal distribution across all participants
  if (totalWeightBig === 0n) {
    const countBig = BigInt(participants.length);
    const baseShare = totalStroops / countBig;
    const remainder = Number(totalStroops % countBig);

    // Sort by ID for deterministic tie-breaking
    const sortedIds = participants.map((p) => p.id).sort();
    const luckySet = new Set(sortedIds.slice(0, remainder));

    for (const p of participants) {
      const extra = luckySet.has(p.id) ? 1n : 0n;
      result.set(p.id, Money.fromStroops(baseShare + extra));
    }
    return result;
  }

  // Calculate lower quotas and fractional remainders
  let allocated = 0n;
  const entries: Array<{ id: string; base: bigint; remainder: bigint; isZeroWeight: boolean }> = [];

  for (const item of scaledWeights) {
    if (item.weightBig === 0n) {
      entries.push({ id: item.id, base: 0n, remainder: 0n, isZeroWeight: true });
      continue;
    }

    const numerator = totalStroops * item.weightBig;
    const base = numerator / totalWeightBig;
    const rem = numerator % totalWeightBig;

    allocated += base;
    entries.push({ id: item.id, base, remainder: rem, isZeroWeight: false });
  }

  const unallocatedRemainder = Number(totalStroops - allocated);

  // Sort remainder entries for deterministic largest remainder allocation:
  // 1. Remainder DESC (largest fractional remainder gets priority)
  // 2. ID ASC (lexicographical tie-breaker ensures array-order independence)
  const remainderEligible = entries
    .filter((e) => !e.isZeroWeight && e.remainder > 0n)
    .sort((a, b) => {
      if (b.remainder !== a.remainder) {
        return b.remainder > a.remainder ? 1 : -1;
      }
      return a.id.localeCompare(b.id);
    });

  const bonusIds = new Set<string>();
  for (let i = 0; i < unallocatedRemainder && i < remainderEligible.length; i++) {
    bonusIds.add(remainderEligible[i].id);
  }

  for (const entry of entries) {
    const extra = bonusIds.has(entry.id) ? 1n : 0n;
    result.set(entry.id, Money.fromStroops(entry.base + extra));
  }

  return result;
}

/**
 * Calculates exact shares for ALL members (including payer).
 * Guarantees sum(allShares) === totalXLM down to the exact stroop.
 */
export function calculateAllShares(
  totalXLM: number | string | Money,
  members: Member[],
  mode: SplitMode = "equal",
): SplitShare[] {
  if (members.length === 0) return [];

  const totalMoney = totalXLM instanceof Money ? totalXLM : Money.parse(totalXLM);
  const participants: ParticipantWeight[] = members.map((m) => ({
    id: m.id,
    weight: mode === "custom" ? (m.weight ?? 1) : 1,
  }));

  const shareMap = apportionShares(totalMoney, participants);

  return members.map((m) => {
    const shareMoney = shareMap.get(m.id) ?? Money.zero();
    return {
      memberId: m.id,
      name: m.name,
      walletAddress: m.walletAddress,
      amount: shareMoney.format(7),
      paid: false,
    };
  });
}

/**
 * Calculates the exact share allocated to the payer.
 */
export function getPayerShare(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
  mode: SplitMode = "equal",
): Money {
  const allShares = calculateAllShares(totalXLM, members, mode);
  const payer = allShares.find((s) => s.memberId === paidByMemberId);
  return payer ? Money.parse(payer.amount) : Money.zero();
}

/**
 * Computes equal split shares for non-payers.
 * Guarantees sum(nonPayerShares) + payerShare === totalXLM exactly.
 */
export function calculateEqualSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
): SplitShare[] {
  if (members.length === 0) return [];
  const nonPayers = members.filter((m) => m.id !== paidByMemberId);
  if (nonPayers.length === 0) return [];

  const allShares = calculateAllShares(totalXLM, members, "equal");
  return allShares.filter((s) => s.memberId !== paidByMemberId);
}

/**
 * Computes custom weighted split shares for non-payers.
 * Guarantees sum(nonPayerShares) + payerShare === totalXLM exactly.
 */
export function calculateCustomSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
): SplitShare[] {
  if (members.length === 0) return [];
  const nonPayers = members.filter((m) => m.id !== paidByMemberId);
  if (nonPayers.length === 0) return [];

  const allShares = calculateAllShares(totalXLM, members, "custom");
  return allShares.filter((s) => s.memberId !== paidByMemberId);
}

/**
 * Dispatcher for split calculations.
 */
export function calculateSplit(
  totalXLM: number | string | Money,
  members: Member[],
  paidByMemberId: string,
  mode: SplitMode,
): SplitShare[] {
  return mode === "custom"
    ? calculateCustomSplit(totalXLM, members, paidByMemberId)
    : calculateEqualSplit(totalXLM, members, paidByMemberId);
}

// ─── Validation helpers ───────────────────────────────────────────────────────

export function isValidXLMAmount(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("-")) return false;

  const dotIndex = trimmed.indexOf(".");
  if (dotIndex !== -1 && trimmed.length - dotIndex - 1 > 7) return false;

  const parsed = Money.tryParse(trimmed);
  if (!parsed || parsed.isNegative() || parsed.isZero()) return false;

  const maxAllowed = 100_000_000n * STROOPS_PER_UNIT;
  return parsed.stroops <= maxAllowed;
}

export function isValidStellarAddress(address: string): boolean {
  return StrKey.isValidEd25519PublicKey(address);
}

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
