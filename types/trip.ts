import type { Expense, Member, SplitMode } from "./expense";
export type { Member } from "./expense";
import type { TravelWorkspace } from "./workspace";
export type { TripPermission, TripRole } from "./expense";

/**
 * Legacy trip-form switches retained for existing trips/templates. New access
 * checks use member roles and granular permissions instead.
 */
export interface TripPermissions {
  membersCanAddExpenses: boolean;
  membersCanInvite: boolean;
}

export type RecurringCadence = "per_trip" | "weekly" | "monthly";

/**
 * A common expense the group repeats (rent, a shared subscription, the
 * annual cabin booking). A rule is a *description* of an expense, never an
 * expense: it has no shares, no payments and no balance, which is what lets a
 * template carry it forward without dragging history along.
 */
export interface RecurringExpenseRule {
  id: string;
  title: string;
  /** Decimal string in the settlement asset (XLM). Never a float. */
  amount: string;
  splitMode: SplitMode;
  /** Member id inside the same trip/template. Remapped on every copy. */
  paidByMemberId?: string;
  cadence: RecurringCadence;
}

export interface Trip {
  id: string;
  name: string;
  description?: string;
  members: Member[];
  expenseIds: string[];
  createdAt: string;
  settled: boolean;
  createdByWallet?: string;
  /** ISO calendar date (YYYY-MM-DD). */
  startsOn?: string;
  /** ISO calendar date (YYYY-MM-DD). */
  endsOn?: string;
  recurringRules?: RecurringExpenseRule[];
  permissions?: TripPermissions;
  /** Provenance: the template this trip was created from, if any. */
  sourceTemplateId?: string;
  /** Provenance: the past trip this trip was duplicated from, if any. */
  copiedFromTripId?: string;
  /** Lightweight travel workspace: itinerary, checklists, booking references */
  workspace?: TravelWorkspace;
  /** Pilot-only shared household chores; disabled until the owner opts in. */
  householdCoordinationEnabled?: boolean;
}

export type TripFormData = {
  name: string;
  description: string;
  members: Member[];
  startsOn?: string;
  endsOn?: string;
  recurringRules?: RecurringExpenseRule[];
  permissions?: TripPermissions;
};

/**
 * A reusable trip structure: who is in the group, what they usually spend on
 * together and what members may do. Deliberately has no expense ids, shares,
 * balances or transaction hashes — see lib/trip/templates.ts.
 */
export interface TripTemplate {
  id: string;
  name: string;
  description?: string;
  members: Member[];
  recurringRules: RecurringExpenseRule[];
  permissions: TripPermissions;
  /** Length of the trip in days, used to suggest an end date. */
  durationDays?: number;
  sourceTripId?: string;
  ownerWallet: string;
  createdAt: string;
  updatedAt: string;
}

export type TripCopySourceKind = "template" | "trip";

export interface TripCopySource {
  kind: TripCopySourceKind;
  id: string;
}

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
