/**
 * Reusable contacts and member profiles (#322).
 *
 * Three rules shape everything here:
 *
 *  1. **Identity is the canonical wallet address, never the name.** Two
 *     contacts called "Sam" are two people; two contacts with the same wallet
 *     are one. Duplicate detection compares canonical addresses only.
 *  2. **An unverified name never implies ownership of a wallet.** A contact's
 *     wallet is "verified" only after its owner signs in and claims the entry.
 *     Until then the UI says so wherever the address appears.
 *  3. **A wallet change never rewrites history.** Past shares, payments and
 *     transaction hashes keep the address they were made with. A new address
 *     is held as a pending change, every active trip that uses the old one is
 *     notified, and only after the notice period can it be used.
 */

import { isValidStellarAddress } from "@/lib/split/calculator";
import { normalizeWalletAddress } from "@/lib/trip/members";
import type { Contact, ContactInput, ContactWalletChange } from "@/types/contact";
import type { Member } from "@/types/expense";
import type { Trip } from "@/types/trip";

/** How long affected trips are notified before a new wallet can be used. */
export const WALLET_CHANGE_NOTICE_HOURS = 24;

export const MAX_DISPLAY_NAME_LENGTH = 80;
export const MAX_INVITE_DESTINATION_LENGTH = 254;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE = /^\+?[0-9 ()-]{6,20}$/;

/** Canonical wallet for comparison, or "" when absent. */
export const canonicalWallet = normalizeWalletAddress;

/**
 * The contact that already uses `walletAddress`, ignoring `excludeId` (the
 * contact being edited). Matching is by canonical address only.
 */
export function findDuplicateByWallet(
  contacts: Pick<Contact, "id" | "walletAddress">[],
  walletAddress: string | undefined | null,
  excludeId?: string,
): Pick<Contact, "id" | "walletAddress"> | undefined {
  const target = canonicalWallet(walletAddress);
  if (!target) return undefined;
  return contacts.find((c) => c.id !== excludeId && canonicalWallet(c.walletAddress) === target);
}

/** Groups contacts that share a canonical wallet — the only real duplicates. */
export function findDuplicateGroups<T extends Pick<Contact, "id" | "walletAddress">>(
  contacts: T[],
): T[][] {
  const byWallet = new Map<string, T[]>();
  for (const contact of contacts) {
    const wallet = canonicalWallet(contact.walletAddress);
    if (!wallet) continue;
    byWallet.set(wallet, [...(byWallet.get(wallet) ?? []), contact]);
  }
  return [...byWallet.values()].filter((group) => group.length > 1);
}

export function detectInviteChannel(destination: string): Contact["inviteChannel"] {
  const value = destination.trim();
  if (EMAIL.test(value)) return "email";
  if (PHONE.test(value)) return "phone";
  return "other";
}

/** Field errors for a contact form; empty when the input is valid. */
export function validateContactInput(
  input: ContactInput,
  existing: Pick<Contact, "id" | "walletAddress">[] = [],
  editingId?: string,
): Record<string, string> {
  const errors: Record<string, string> = {};
  const name = input.displayName.trim();
  if (!name) errors.displayName = "Name is required";
  else if (name.length > MAX_DISPLAY_NAME_LENGTH) {
    errors.displayName = `Keep the name under ${MAX_DISPLAY_NAME_LENGTH} characters`;
  }

  const wallet = canonicalWallet(input.walletAddress);
  if (wallet && !isValidStellarAddress(wallet)) {
    errors.walletAddress = "Invalid Stellar address (must start with G, 56 chars).";
  } else if (wallet && findDuplicateByWallet(existing, wallet, editingId)) {
    errors.walletAddress = "You already have a contact with this wallet address.";
  }

  const destination = input.inviteDestination?.trim() ?? "";
  if (destination.length > MAX_INVITE_DESTINATION_LENGTH) {
    errors.inviteDestination = "That invite destination is too long";
  } else if (input.inviteChannel === "email" && destination && !EMAIL.test(destination)) {
    errors.inviteDestination = "Enter a valid email address";
  } else if (input.inviteChannel === "phone" && destination && !PHONE.test(destination)) {
    errors.inviteDestination = "Enter a valid phone number";
  }

  return errors;
}

/** Canonical, trimmed form of a contact input, as stored. */
export function normalizeContactInput(input: ContactInput): ContactInput {
  const destination = input.inviteDestination?.trim() || undefined;
  return {
    displayName: input.displayName.trim(),
    walletAddress: canonicalWallet(input.walletAddress) || undefined,
    inviteDestination: destination,
    inviteChannel: destination ? input.inviteChannel ?? detectInviteChannel(destination) : undefined,
  };
}

export type WalletTrust = "verified" | "unverified" | "none";

/**
 * How much the UI may say about a contact's wallet. Never "verified" unless
 * the claimed wallet is the one currently on the contact.
 */
export function walletTrust(contact: Pick<Contact, "walletAddress" | "walletVerified" | "claimedByWallet">): WalletTrust {
  const wallet = canonicalWallet(contact.walletAddress);
  if (!wallet) return "none";
  return contact.walletVerified && canonicalWallet(contact.claimedByWallet) === wallet
    ? "verified"
    : "unverified";
}

export const WALLET_TRUST_LABELS: Record<WalletTrust, string> = {
  verified: "Verified by owner",
  unverified: "Unverified — entered by you",
  none: "No wallet yet",
};

/** A trip member created from a contact. Fresh id; wallet only if known. */
export function contactToMember(contact: Contact, newId: () => string = () => crypto.randomUUID()): Member {
  const wallet = canonicalWallet(contact.walletAddress);
  return { id: newId(), name: contact.displayName, ...(wallet ? { walletAddress: wallet } : {}) };
}

/**
 * Active (unsettled) trips that list `wallet` as a member — the groups that
 * must be told before that member's address changes. Settled trips are
 * history and keep the old address untouched.
 */
export function affectedActiveTrips(trips: Trip[], wallet: string | undefined | null): Trip[] {
  const target = canonicalWallet(wallet);
  if (!target) return [];
  return trips.filter(
    (trip) =>
      !trip.settled &&
      trip.members.some((member) => canonicalWallet(member.walletAddress) === target),
  );
}

/** Whether a pending change may be applied at `now`. */
export function canApplyWalletChange(
  change: Pick<ContactWalletChange, "status" | "noticeUntil" | "affectedTripIds">,
  now: Date = new Date(),
): boolean {
  if (change.status !== "pending_notice") return false;
  // With no active group using the old wallet there is nobody to warn.
  if (change.affectedTripIds.length === 0) return true;
  return Date.parse(change.noticeUntil) <= now.getTime();
}

/** Human-readable time left before a change can be applied. */
export function describeNoticeRemaining(noticeUntil: string, now: Date = new Date()): string {
  const ms = Date.parse(noticeUntil) - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return "now";
  const hours = Math.ceil(ms / (60 * 60 * 1000));
  return hours <= 1 ? "in under an hour" : `in ${hours} hours`;
}

/** Pending changes that concern members of this trip, for the trip banner. */
export function walletChangesForTrip(
  changes: ContactWalletChange[],
  tripId: string,
): ContactWalletChange[] {
  return changes.filter((c) => c.status === "pending_notice" && c.affectedTripIds.includes(tripId));
}
