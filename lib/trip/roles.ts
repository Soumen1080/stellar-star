import type { Member } from "@/types/expense";
import type { Trip, TripPermission, TripRole } from "@/types/trip";

const VALID_ROLES = new Set<TripRole>(["owner", "organizer", "contributor", "viewer", "custom"]);
export const TRIP_PERMISSIONS: TripPermission[] = [
  "trip.settings.manage",
  "members.manage",
  "expenses.manage",
  "receipts.manage",
  "exports.view",
  "reminders.manage",
  "settlement.proposals.manage",
];

const PERMISSIONS: Record<Exclude<TripRole, "custom">, TripPermission[]> = {
  owner: [
    "trip.settings.manage",
    "members.manage",
    "expenses.manage",
    "receipts.manage",
    "exports.view",
    "reminders.manage",
    "settlement.proposals.manage",
  ],
  organizer: [
    "trip.settings.manage",
    "members.manage",
    "expenses.manage",
    "receipts.manage",
    "exports.view",
    "reminders.manage",
    "settlement.proposals.manage",
  ],
  contributor: ["expenses.manage", "receipts.manage", "exports.view"],
  viewer: ["exports.view"],
};

export function isTripPermission(value: unknown): value is TripPermission {
  return TRIP_PERMISSIONS.some((permission) => permission === value);
}

export function normalizeRole(role: unknown): TripRole {
  return typeof role === "string" && VALID_ROLES.has(role as TripRole)
    ? (role as TripRole)
    : "contributor";
}

export function memberRole(member: Member, trip: Trip): TripRole {
  if (member.role) return normalizeRole(member.role);
  const wallet = member.walletAddress?.trim().toUpperCase();
  const creator = trip.createdByWallet?.trim().toUpperCase();
  return wallet && creator && wallet === creator ? "owner" : "contributor";
}

export function permissionsForMember(member: Member, trip: Trip): TripPermission[] {
  const role = memberRole(member, trip);
  if (role === "custom") {
    return [...new Set((member.customPermissions ?? []).filter((permission) =>
      TRIP_PERMISSIONS.includes(permission),
    ))];
  }
  return [...PERMISSIONS[role]];
}

export function memberHasPermission(
  member: Member,
  permission: TripPermission,
  trip: Trip,
): boolean {
  return permissionsForMember(member, trip).includes(permission);
}

export function canManageTripRoles(trip: Trip, wallet: string): boolean {
  const canonical = wallet.trim().toUpperCase();
  return trip.members.some(
    (member) => memberRole(member, trip) === "owner" &&
      member.walletAddress?.trim().toUpperCase() === canonical,
  );
}
