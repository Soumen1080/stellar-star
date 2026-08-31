import type { Expense, Member } from "./expense";

export interface Trip {
  id: string;
  name: string;
  description?: string;
  members: Member[];
  expenseIds: string[];
  createdAt: string;
  settled: boolean;
  createdByWallet?: string;
}

export type TripFormData = {
  name: string;
  description: string;
  members: Member[];
};

export interface TripInvite {
  id: string;
  tripId: string;
  tokenHash: string;
  memberId?: string | null;
  createdByWallet: string;
  expiresAt: string;
  maxUses: number;
  uses: number;
  revoked: boolean;
  revokedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TripInviteSummary {
  inviteId: string;
  tripId: string;
  tripName: string;
  tripDescription?: string;
  memberId?: string | null;
  memberName?: string | null;
  inviterWallet: string;
  expiresAt: string;
  unclaimedMembers: Array<{ id: string; name: string }>;
  isExpired: boolean;
  isRevoked: boolean;
  isExhausted: boolean;
}
