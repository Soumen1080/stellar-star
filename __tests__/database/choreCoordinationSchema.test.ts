import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(
  path.join(ROOT, "migrations/0019_trip_chore_coordination.sql"),
  "utf8",
).trim();
const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8").trim();

describe.each([
  ["migration", migration],
  ["setup", setup],
])("chore coordination database safeguards (%s)", (_name, sql) => {
  const appendStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.append_trip_chore_completion");
  const appendEnd = sql.indexOf("$fn$;", appendStart);
  const appendFunction = sql.slice(appendStart, appendEnd);

  it("serializes completions and checks assignment and period before appending", () => {
    expect(appendFunction).toContain("FOR UPDATE");
    expect(appendFunction).toContain("CHORE_ALREADY_COMPLETED_THIS_PERIOD");
    expect(appendFunction).toContain("IF v_member_id IS DISTINCT FROM v_assigned_member_id");
    expect(appendFunction).toContain("'completedByWallet', public.current_wallet()");
  });

  it("enforces owner-only configuration and server-owned completion history", () => {
    expect(sql).toContain("CHORE_HISTORY_SERVER_ONLY");
    expect(sql).toContain("CHORE_CONFIGURATION_FORBIDDEN");
    expect(sql).toContain("public.trip_member_role(OLD.id, public.current_wallet()) IS DISTINCT FROM 'owner'");
  });
});

it("keeps the cumulative setup identical to migration 0019", () => {
  expect(setup.endsWith(migration)).toBe(true);
});
