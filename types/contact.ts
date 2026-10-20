/**
 * A private address-book entry. Visible only to the wallet that created it.
 *
 * `walletAddress` alone proves nothing: anyone can type any address next to any
 * name. Only `walletVerified` (set when the wallet's owner signs in and claims
 * the entry) means the named person controls that wallet.
 */
export interface Contact {
  id: string;
  ownerWallet: string;
  displayName: string;
  /** Canonical (trimmed, uppercase) G… address, or undefined if unknown. */
  walletAddress?: string;
  walletVerified: boolean;
  /** Wallet that proved ownership by claiming this entry. */
  claimedByWallet?: string;
  verifiedAt?: string;
  /** Where to send an invite when the person has no wallet yet. */
  inviteDestination?: string;
  inviteChannel?: ContactInviteChannel;
  /** True while an unexpired claim link exists. */
  hasPendingClaim: boolean;
  createdAt: string;
  updatedAt: string;
}

export type ContactInviteChannel = "email" | "phone" | "other";

export type ContactInput = {
  displayName: string;
  walletAddress?: string;
  inviteDestination?: string;
  inviteChannel?: ContactInviteChannel;
};

export type WalletChangeStatus = "pending_notice" | "applied" | "cancelled";

/**
 * A requested change of a contact's wallet. The new address is not used
 * anywhere until the change is applied, which can happen only after every
 * affected active trip has been notified for the notice period.
 */
export interface ContactWalletChange {
  id: string;
  contactId: string;
  ownerWallet: string;
  contactName: string;
  oldWallet?: string;
  newWallet: string;
  status: WalletChangeStatus;
  /** Active (unsettled) trips that list the old wallet as a member. */
  affectedTripIds: string[];
  /** The change cannot be applied before this time. */
  noticeUntil: string;
  /** True when the new wallet was proven by its owner (claim flow). */
  verified: boolean;
  createdAt: string;
  appliedAt?: string;
}
