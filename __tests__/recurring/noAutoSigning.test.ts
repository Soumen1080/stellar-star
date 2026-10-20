/**
 * Recurring drafts must never request a wallet signature or move money (#319).
 * Enforced structurally: nothing in the recurring feature may import the
 * payment, wallet or Stellar transaction layers.
 */
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const FILES = [
  "lib/recurring/schedule.ts",
  "lib/recurring/generate.ts",
  "lib/recurring/queries.ts",
  "app/api/recurring/run/route.ts",
  "components/recurring/RecurringPanel.tsx",
];
const FORBIDDEN = [
  /@\/lib\/stellar\//,
  /@\/lib\/freighter/,
  /@\/lib\/settlement\//,
  /@\/hooks\/use(Net|Path)?Payment/,
  /@\/hooks\/useWallet/,
  /@stellar\//,
  /walletsKit/,
];

describe("recurring drafts never trigger signing", () => {
  it.each(FILES)("%s imports no payment or wallet code", (file) => {
    const source = fs.readFileSync(path.join(ROOT, file), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    const offending = imports.filter((spec) => FORBIDDEN.some((re) => re.test(spec)));
    expect({ file, offending }).toEqual({ file, offending: [] });
  });

  it("the drafts table cannot be inserted as anything but pending", () => {
    const sql = fs.readFileSync(path.join(ROOT, "migrations/0010_recurring_expenses.sql"), "utf8");
    expect(sql).toContain("NEW.status := 'pending';");
    expect(sql).toContain("CONSTRAINT expense_drafts_one_per_occurrence UNIQUE (template_id, occurrence_date)");
  });
});
