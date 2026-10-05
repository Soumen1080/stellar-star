import { StrKey } from "@stellar/stellar-sdk";
import type { Member } from "@/types/expense";

/**
 * Normalizes a Stellar wallet address to canonical uppercase trimmed format.
 * Returns an empty string if the address is null, undefined, or empty.
 */
export function normalizeWalletAddress(address?: string | null): string {
  if (!address || typeof address !== "string") return "";
  return address.trim().toUpperCase();
}

/**
 * Alias for normalizeWalletAddress.
 */
export const canonicalAddress = normalizeWalletAddress;

/**
 * Validates whether an address string is a valid Stellar Ed25519 public key
 * after applying canonical normalization (trim and uppercase).
 */
export function isValidMemberAddress(address?: string | null): boolean {
  const canonical = normalizeWalletAddress(address);
  if (!canonical) return false;
  return StrKey.isValidEd25519PublicKey(canonical);
}

/**
 * Case-insensitive, whitespace-trimmed comparison of two Stellar addresses.
 */
export function areWalletAddressesEqual(
  addr1?: string | null,
  addr2?: string | null
): boolean {
  const norm1 = normalizeWalletAddress(addr1);
  const norm2 = normalizeWalletAddress(addr2);
  if (!norm1 || !norm2) return false;
  return norm1 === norm2;
}

/**
 * Normalizes a member's fields at the boundary.
 * Trims name and canonicalizes walletAddress if present.
 */
export function normalizeMember<T extends { walletAddress?: string; name?: string }>(
  member: T
): T {
  return {
    ...member,
    ...(typeof member.name === "string" ? { name: member.name.trim() } : {}),
    ...(member.walletAddress !== undefined
      ? { walletAddress: member.walletAddress ? normalizeWalletAddress(member.walletAddress) : "" }
      : {}),
  };
}

/**
 * Normalizes an array of members.
 */
export function normalizeMembers<T extends { walletAddress?: string; name?: string }>(
  members: T[]
): T[] {
  return members.map(normalizeMember);
}

/**
 * Checks whether a given wallet address belongs to a trip's member list.
 * Performs canonical case-insensitive and trimmed comparison to prevent invite
 * membership check failures.
 */
export function isMemberInTrip(
  members: Array<{ walletAddress?: string } | null | undefined>,
  walletAddress?: string | null
): boolean {
  const canonicalTarget = normalizeWalletAddress(walletAddress);
  if (!canonicalTarget) return false;

  return members.some((m) => {
    if (!m?.walletAddress) return false;
    return normalizeWalletAddress(m.walletAddress) === canonicalTarget;
  });
}

/**
 * Alias for isMemberInTrip.
 */
export const hasMemberWithAddress = isMemberInTrip;

/**
 * Finds a member in a list by their wallet address using canonical comparison.
 */
export function findMemberByWallet<T extends { walletAddress?: string }>(
  members: T[],
  walletAddress?: string | null
): T | undefined {
  const canonicalTarget = normalizeWalletAddress(walletAddress);
  if (!canonicalTarget) return undefined;

  return members.find((m) => normalizeWalletAddress(m.walletAddress) === canonicalTarget);
}

/**
 * Deduplicates a list of members by their canonical wallet address.
 * Preserves members without wallet addresses.
 */
export function deduplicateMembers<T extends { walletAddress?: string }>(
  members: T[]
): T[] {
  const seen = new Set<string>();
  const result: T[] = [];

  for (const member of members) {
    const canonical = normalizeWalletAddress(member.walletAddress);
    if (!canonical) {
      result.push(member);
      continue;
    }
    if (seen.has(canonical)) {
      continue;
    }
    seen.add(canonical);
    result.push(member);
  }

  return result;
}

/**
 * Checks for duplicate wallet addresses among candidate members or addresses.
 * Returns a map of index -> error message for all duplicate entries.
 */
export function findDuplicateMemberAddresses(
  items: Array<{ walletAddress?: string } | string | undefined | null>
): Record<number, string> {
  const seen = new Map<string, number>();
  const errors: Record<number, string> = {};

  items.forEach((item, index) => {
    const raw = typeof item === "string" ? item : item?.walletAddress;
    const canonical = normalizeWalletAddress(raw);
    if (!canonical || !isValidMemberAddress(canonical)) return;

    const firstIndex = seen.get(canonical);
    if (firstIndex === undefined) {
      seen.set(canonical, index);
      return;
    }

    errors[index] = `Duplicate wallet address — already used by member ${firstIndex + 1}.`;
    if (!errors[firstIndex]) {
      errors[firstIndex] = `Duplicate wallet address — also used by member ${index + 1}.`;
    }
  });

  return errors;
}
