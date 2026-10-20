import type { Trip } from "@/types/trip";
import type { Member } from "@/types/expense";
import {
  canManageTripRoles,
  memberHasPermission,
  memberRole,
  normalizeRole,
  permissionsForMember,
} from "@/lib/trip/roles";

const OWNER = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
const MEMBER = "GAYP4BR4UCI2OT6T7OMVZWWDGCFXHCB7NH64UNGPUHSND3F5SJKBS7AU";

const trip: Trip = {
  id: "trip-1",
  name: "Role test",
  members: [
    { id: "owner", name: "Owner", walletAddress: OWNER, role: "owner" },
    { id: "organizer", name: "Organizer", walletAddress: MEMBER, role: "organizer" },
    { id: "viewer", name: "Viewer", role: "viewer" },
  ],
  expenseIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  settled: false,
  createdByWallet: OWNER,
};

describe("trip role matrix", () => {
  it("keeps the legacy creator as owner only when no explicit role exists", () => {
    expect(memberRole({ id: "legacy", name: "Legacy", walletAddress: OWNER }, trip)).toBe("owner");
    expect(memberRole({ ...trip.members[0], role: "viewer" }, trip)).toBe("viewer");
  });

  it("grants the documented built-in permissions", () => {
    expect(memberHasPermission(trip.members[1], "members.manage", trip)).toBe(true);
    expect(memberHasPermission(trip.members[1], "expenses.manage", trip)).toBe(true);
    expect(memberHasPermission(trip.members[2], "expenses.manage", trip)).toBe(false);
    expect(memberHasPermission(trip.members[2], "exports.view", trip)).toBe(true);
  });

  it("uses the explicitly selected subset for a custom role", () => {
    const custom: Member = {
      id: "custom",
      name: "Custom",
      role: "custom",
      customPermissions: ["reminders.manage", "exports.view"],
    };
    expect(permissionsForMember(custom, trip)).toEqual(["reminders.manage", "exports.view"]);
    expect(memberHasPermission(custom, "reminders.manage", trip)).toBe(true);
    expect(memberHasPermission(custom, "expenses.manage", trip)).toBe(false);
  });

  it("only lets an owner manage role assignments", () => {
    expect(canManageTripRoles(trip, OWNER.toLowerCase())).toBe(true);
    expect(canManageTripRoles(trip, MEMBER)).toBe(false);
  });

  it("normalizes unknown roles to contributor", () => {
    expect(normalizeRole("not-a-role")).toBe("contributor");
  });
});
