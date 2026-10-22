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

  it("normalizes legacy workspaces and keeps chores as non-financial references", () => {
    const normalized = normalizeWorkspace({ itinerary: [], checklists: [], bookings: [] });
    expect(normalized.chores).toEqual([]);
    expect(normalized.choreOptOutWallets).toEqual([]);
    expect(normalized.choresEnabled).toBe(true);

    expect(chore).toHaveProperty("linkedExpenseId", "expense-soap");
    expect(chore).not.toHaveProperty("amount");
    expect(chore).not.toHaveProperty("shares");
    expect(chore).not.toHaveProperty("payment");
  });
});
