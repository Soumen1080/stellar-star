import { rowToHouseholdChore, rowToHouseholdChoreCompletion, rowToTrip } from "@/lib/supabase/queries";
import type { HouseholdChoreCompletionRow, HouseholdChoreRow } from "@/types/householdChore";
import type { TripRow } from "@/types/supabase";

describe("household persistence mappers", () => {
  it("maps chore and completion rows without adding money or payment properties", () => {
    const choreRow: HouseholdChoreRow = {
      id: "chore-1",
      trip_id: "trip-1",
      title: "Take out recycling",
      details: null,
      cadence: "weekly",
      rotation_wallets: ["GALICE", "GBOB"],
      rotation_cursor: 1,
      next_due_on: "2026-10-29",
      active: true,
      created_by_wallet: "GALICE",
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
    };
    const completionRow: HouseholdChoreCompletionRow = {
      id: "completion-1",
      chore_id: "chore-1",
      trip_id: "trip-1",
      completed_by_wallet: "GBOB",
      due_on: "2026-10-22",
      supply_expense_id: "expense-1",
      completed_at: "2026-10-22T08:00:00.000Z",
    };

    expect(rowToHouseholdChore(choreRow)).toMatchObject({
      id: "chore-1",
      rotationCursor: 1,
      cadence: "weekly",
    });
    expect(rowToHouseholdChore(choreRow)).not.toHaveProperty("shares");
    expect(rowToHouseholdChoreCompletion(completionRow)).toMatchObject({
      choreId: "chore-1",
      supplyExpenseId: "expense-1",
    });
    expect(rowToHouseholdChoreCompletion(completionRow)).not.toHaveProperty("paid");
  });

  it("treats missing feature state as disabled on older trip rows", () => {
    const tripRow = {
      id: "trip-1",
      name: "Flat",
      description: null,
      members: [],
      expense_ids: [],
      settled: false,
      created_by_wallet: "GALICE",
      member_wallets: ["GALICE"],
      starts_on: null,
      ends_on: null,
      recurring_rules: [],
      permissions: {},
      source_template_id: null,
      copied_from_trip_id: null,
      created_at: "2026-10-20T00:00:00.000Z",
      updated_at: "2026-10-20T00:00:00.000Z",
    } as unknown as TripRow;
    expect(rowToTrip(tripRow).householdCoordinationEnabled).toBe(false);
  });
});
