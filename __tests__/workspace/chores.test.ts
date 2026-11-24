import {
  choreCompletedThisPeriod,
  chorePeriodKey,
  currentChoreAssignee,
  normalizeWorkspace,
  type RecurringChore,
} from "@/types/workspace";

describe("recurring chore coordination", () => {
  const chore: RecurringChore = {
    id: "chore-dishes",
    tripId: "trip-flat",
    title: "Wash the dishes",
    cadence: "weekly",
    rotationMemberIds: ["member-a", "member-b"],
    completionHistory: [],
    linkedExpenseId: "expense-soap",
    createdByWallet: "WALLET_A",
    createdAt: "2026-10-19T08:00:00.000Z",
  };

  it("rotates the next assignee after a completion and tracks the recurrence period", () => {
    expect(currentChoreAssignee(chore)).toBe("member-a");
    expect(currentChoreAssignee(chore, ["member-a"])).toBe("member-b");
    expect(currentChoreAssignee(chore, ["member-a", "member-b"])).toBeNull();
    expect(choreCompletedThisPeriod(chore, new Date("2026-10-21T12:00:00Z"))).toBe(false);

    const completed = {
      ...chore,
      completionHistory: [{
        completedAt: "2026-10-20T12:00:00.000Z",
        completedByWallet: "WALLET_A",
        assignedMemberId: "member-a",
        periodKey: chorePeriodKey("weekly", new Date("2026-10-20T12:00:00Z")),
      }],
    };
    expect(choreCompletedThisPeriod(completed, new Date("2026-10-25T12:00:00Z"))).toBe(true);
    expect(currentChoreAssignee(completed)).toBe("member-b");
    expect(choreCompletedThisPeriod(completed, new Date("2026-10-26T00:00:00Z"))).toBe(false);
  });

  it("rotates across eligible members when one or several members opt out", () => {
    const threeMembers: RecurringChore = {
      ...chore,
      rotationMemberIds: ["member-a", "member-b", "member-c"],
    };
    const completedByA: RecurringChore = {
      ...threeMembers,
      completionHistory: [{
        completedAt: "2026-10-20T12:00:00.000Z",
        completedByWallet: "WALLET_A",
        assignedMemberId: "member-a",
        periodKey: "2026-10-19",
      }],
    };

    expect(currentChoreAssignee(completedByA, ["member-b"])).toBe("member-c");
    expect(currentChoreAssignee(completedByA, ["member-b", "member-c"])).toBe("member-a");
    expect(currentChoreAssignee(completedByA, ["member-a", "member-b", "member-c"])).toBeNull();
  });

  it("includes members who opt back in without losing the last-assignee position", () => {
    const threeMembers: RecurringChore = {
      ...chore,
      rotationMemberIds: ["member-a", "member-b", "member-c"],
      completionHistory: [{
        completedAt: "2026-10-20T12:00:00.000Z",
        completedByWallet: "WALLET_A",
        assignedMemberId: "member-a",
        periodKey: "2026-10-19",
      }],
    };

    expect(currentChoreAssignee(threeMembers, ["member-b"])).toBe("member-c");
    expect(currentChoreAssignee(threeMembers)).toBe("member-b");
  });

  it("uses UTC daily, weekly, and monthly period boundaries", () => {
    expect(chorePeriodKey("daily", new Date("2026-10-31T23:59:59Z"))).toBe("2026-10-31");
    expect(chorePeriodKey("daily", new Date("2026-11-01T00:00:00Z"))).toBe("2026-11-01");
    expect(chorePeriodKey("weekly", new Date("2026-10-25T23:59:59Z"))).toBe("2026-10-19");
    expect(chorePeriodKey("weekly", new Date("2026-10-26T00:00:00Z"))).toBe("2026-10-26");
    expect(chorePeriodKey("monthly", new Date("2026-10-31T23:59:59Z"))).toBe("2026-10");
    expect(chorePeriodKey("monthly", new Date("2026-11-01T00:00:00Z"))).toBe("2026-11");
  });

  it("normalizes legacy workspaces and keeps chores as non-financial references", () => {
    const normalized = normalizeWorkspace({ itinerary: [], checklists: [], bookings: [] });
    expect(normalized.chores).toEqual([]);
    expect(normalized.choreOptOutWallets).toEqual([]);
    expect(normalized.choresEnabled).toBe(true);
    expect(normalizeWorkspace({
      choreOptOutWallets: [" wallet_a ", "WALLET_A", 4],
    }).choreOptOutWallets).toEqual(["WALLET_A"]);
    expect(normalizeWorkspace({})).toMatchObject({
      chores: [],
      choreOptOutWallets: [],
      choresEnabled: true,
    });

    expect(chore).toHaveProperty("linkedExpenseId", "expense-soap");
    expect(chore).not.toHaveProperty("amount");
    expect(chore).not.toHaveProperty("shares");
    expect(chore).not.toHaveProperty("payment");
  });
});
