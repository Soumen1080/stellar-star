import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../migrations/0019_shared_household_coordination.sql"),
  "utf8",
);

describe("shared household coordination migration", () => {
  it("stores chores and append-only completion history outside of the finance model", () => {
    expect(migration).toContain("household_coordination_enabled BOOLEAN NOT NULL DEFAULT FALSE");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.household_chores");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS public.household_chore_completions");
    expect(migration).toContain("UNIQUE (chore_id, due_on)");
    expect(migration).not.toMatch(/(?:INSERT|UPDATE|DELETE)\s+INTO\s+public\.(?:expenses|settlement_intents)/i);
    expect(migration).not.toContain("UPDATE public.household_chore_completions");
  });

  it("guards module settings, opt-out preferences, and member access with RLS", () => {
    expect(migration).toContain("HOUSEHOLD_COORDINATION_OWNER_ONLY");
    expect(migration).toContain("household_chore_preferences_insert_self");
    expect(migration).toContain("household_chore_preferences_update_self");
    expect(migration).toContain("HOUSEHOLD_MEMBER_OPTED_OUT");
    expect(migration).toContain("trip.household_coordination_enabled");
  });

  it("completes and rotates a due chore atomically without accepting arbitrary expense links", () => {
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.complete_household_chore");
    expect(migration).toContain("FOR UPDATE");
    expect(migration).toContain("HOUSEHOLD_CHORE_ASSIGNED_TO_ANOTHER_MEMBER");
    expect(migration).toContain("v_trip.expense_ids @> ARRAY[p_supply_expense_id::TEXT]");
    expect(migration).toContain("rotation_cursor = (v_rotation_index + 1)");
  });
});
