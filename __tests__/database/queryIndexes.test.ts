import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(
  path.join(ROOT, "migrations/0007_composite_query_indexes.sql"),
  "utf8",
);
const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");
const queries = fs.readFileSync(path.join(ROOT, "lib/supabase/queries.ts"), "utf8");
const reconciliation = fs.readFileSync(
  path.join(ROOT, "migrations/0003_reconcile_drifted_schema.sql"),
  "utf8",
);

const expectedIndexes = [
  "idx_expenses_creator_created_at",
  "idx_expenses_settled_created_at",
  "idx_trips_creator_created_at",
  "idx_trips_settled_created_at",
  "idx_trip_invites_trip_created_at",
  "settlement_intents_member_status_created_at_idx",
  "auth_challenges_address_created_at_idx",
];

describe("composite query index coverage", () => {
  it.each(expectedIndexes)("defines %s in both provisioning paths", (indexName) => {
    expect(migration).toContain(indexName);
    expect(setup).toContain(indexName);
  });

  it("covers the settlement intent filter and sort in column order", () => {
    expect(migration).toMatch(
      /settlement_intents\s*\(member_wallet,\s*status,\s*created_at\s+DESC\)/i,
    );
    expect(queries).toMatch(
      /eq\("member_wallet"[\s\S]*?in\("status"[\s\S]*?order\("created_at"/,
    );
  });

  it("uses the GIN-indexable containment operator in wallet RLS", () => {
    expect(migration).toMatch(
      /CREATE POLICY expenses_select_members[\s\S]*?member_wallets\s*@>\s*ARRAY\[public\.current_wallet\(\)\]/i,
    );
    expect(migration).toMatch(
      /CREATE POLICY trips_select_members[\s\S]*?member_wallets\s*@>\s*ARRAY\[public\.current_wallet\(\)\]/i,
    );
  });

  it("does not invent the trip_id or trip_members columns absent from this schema", () => {
    expect(migration).not.toMatch(/public\.expenses\s*\(trip_id/i);
    expect(migration).not.toMatch(/public\.trip_members/i);
  });

  it("creates tables and reconciles legacy columns before indexing them", () => {
    const authTable = setup.indexOf("CREATE TABLE IF NOT EXISTS public.auth_rate_limits");
    const authIndex = setup.indexOf("CREATE INDEX IF NOT EXISTS auth_rate_limits_window_idx");
    const statusColumn = reconciliation.indexOf("ADD COLUMN IF NOT EXISTS status");
    const statusIndex = reconciliation.indexOf("sponsored_accounts_status_idx");

    expect(authTable).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(authTable);
    expect(statusColumn).toBeGreaterThanOrEqual(0);
    expect(statusIndex).toBeGreaterThan(statusColumn);
  });

  it("records migration 0007 in the cumulative setup path", () => {
    expect(setup).toContain(
      "('0007', '0007_composite_query_indexes', 'composite_query_indexes_v1')",
    );
  });
});
