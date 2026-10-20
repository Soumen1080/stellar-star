import fs from "node:fs";
import path from "node:path";
import { RECEIPT_BUCKET, RECEIPT_CONTENT_TYPES } from "@/lib/receipts/policy";

const ROOT = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(path.join(ROOT, "migrations/0009_expense_receipts.sql"), "utf8");
const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

describe.each([
  ["migration", migration],
  ["setup", setup],
])("receipt storage schema (%s)", (_name, sql) => {
  const section = sql.slice(sql.indexOf("CREATE TABLE IF NOT EXISTS public.expense_receipts"));

  it("creates the bucket as private", () => {
    expect(section).toContain(`'${RECEIPT_BUCKET}', '${RECEIPT_BUCKET}', FALSE`);
    expect(section).not.toMatch(/public\s*=\s*TRUE/i);
  });

  it("gives clients read-only access through expense membership", () => {
    expect(section).toMatch(/CREATE POLICY expense_receipts_select_members[\s\S]*?FOR SELECT/);
    expect(section).toMatch(/member_wallets @> ARRAY\[public\.current_wallet\(\)\]/);
    expect(section).not.toMatch(/CREATE POLICY \w+ ON public\.expense_receipts\s+FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(section).not.toMatch(/GRANT [^;]*(INSERT|UPDATE|DELETE)[^;]* ON public\.expense_receipts/);
    // Nothing grants client access to stored objects.
    expect(section).not.toMatch(/ON storage\.objects/);
  });

  it("allowlists exactly the content types the server accepts", () => {
    for (const type of RECEIPT_CONTENT_TYPES) expect(section).toContain(`'${type}'`);
    expect(section).not.toContain("image/svg");
  });

  it("does not cascade-delete metadata when an expense is deleted", () => {
    expect(section).toMatch(/REFERENCES public\.expenses \(id\) ON DELETE SET NULL/);
  });
});
