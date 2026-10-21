import fs from "node:fs";
import path from "node:path";

const migration = fs.readFileSync(
  path.resolve(__dirname, "../../migrations/0016_trip_roles_and_permissions.sql"),
  "utf8",
);

describe("trip role authorization migration", () => {
  it("checks role permissions in RLS for trip, expense, receipt, reminder, and proposal writes", () => {
    for (const permission of [
      "trip.settings.manage",
      "members.manage",
      "expenses.manage",
      "receipts.manage",
      "exports.view",
      "reminders.manage",
      "settlement.proposals.manage",
    ]) {
      expect(migration).toContain(permission);
    }
    expect(migration).toContain("CREATE POLICY trips_update_authorized");
    expect(migration).toContain("CREATE POLICY expenses_update_authorized");
    expect(migration).toContain("CREATE POLICY expense_receipts_select_members");
    expect(migration).toContain("CREATE POLICY payment_reminders_insert_sender");
    expect(migration).toContain("CREATE POLICY settlement_proposals_insert_member");
  });

  it("restricts role assignments and records both sides of ownership transfers", () => {
    expect(migration).toContain("ROLE_CHANGE_FORBIDDEN");
    expect(migration).toContain("OWNERSHIP_TRANSFER_REQUIRED");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.transfer_trip_ownership");
    expect(migration).toContain("INSERT INTO public.trip_role_audit");
    expect(migration).toContain("trip_member_role(trip_id, public.current_wallet()) IS NOT NULL");
  });
});
