import { nextChoreAssignee, nextChoreDueDate } from "@/lib/household/rotation";
import type { HouseholdChore, HouseholdChorePreference } from "@/types/householdChore";

const chore: Pick<HouseholdChore, "rotationWallets" | "rotationCursor"> = {
  rotationWallets: ["GALICE", "GBOB", "GCARA"],
  rotationCursor: 0,
};

describe("household chore rotation", () => {
  it("starts with the first member and advances from the current cursor", () => {
    expect(nextChoreAssignee(chore, [], ["GALICE", "GBOB", "GCARA"])).toEqual({
      walletAddress: "GALICE",
      rotationIndex: 0,
    });
    expect(nextChoreAssignee({ ...chore, rotationCursor: 2 }, [], ["GALICE", "GBOB", "GCARA"]))
      .toEqual({ walletAddress: "GCARA", rotationIndex: 2 });
  });

  it("skips opted-out and no-longer-active members case-insensitively", () => {
    const preferences: HouseholdChorePreference[] = [
      { tripId: "trip", walletAddress: "galice", optedOut: true },
    ];
    expect(nextChoreAssignee(chore, preferences, ["GALICE", "GBOB", "GCARA"]))
      .toEqual({ walletAddress: "GBOB", rotationIndex: 1 });
    expect(nextChoreAssignee(chore, [], ["GBOB", "GCARA"]))
      .toEqual({ walletAddress: "GBOB", rotationIndex: 1 });
  });

  it("returns no assignee when all members opted out or left the trip", () => {
    expect(nextChoreAssignee(chore, [], [])).toBeNull();
    expect(nextChoreAssignee(chore, [
      { tripId: "trip", walletAddress: "GALICE", optedOut: true },
      { tripId: "trip", walletAddress: "GBOB", optedOut: true },
      { tripId: "trip", walletAddress: "GCARA", optedOut: true },
    ], ["GALICE", "GBOB", "GCARA"])).toBeNull();
  });

  it("advances weekly and biweekly schedules by calendar days", () => {
    expect(nextChoreDueDate("2026-12-28", "weekly")).toBe("2027-01-04");
    expect(nextChoreDueDate("2026-12-28", "biweekly")).toBe("2027-01-11");
  });

  it("clamps a monthly recurrence to the last valid date in the next month", () => {
    expect(nextChoreDueDate("2026-01-31", "monthly")).toBe("2026-02-28");
    expect(nextChoreDueDate("2026-12-31", "monthly")).toBe("2027-01-31");
  });
});
