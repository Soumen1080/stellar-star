import fs from "node:fs";
import path from "node:path";
import { EXPENSE_CATEGORIES } from "@/lib/expense/categories";

const ROOT = path.resolve(__dirname, "../..");
const migration = fs.readFileSync(
  path.join(ROOT, "migrations/0008_expense_categories_tags_search.sql"),
  "utf8",
);
const setup = fs.readFileSync(path.join(ROOT, "supabase-setup.sql"), "utf8");

describe("expense categories, tags and search schema (#317)", () => {
  it.each([
    ["migration", migration],
    ["setup", setup],
  ])("%s: search runs under the caller's RLS", (_name, sql) => {
    const fn = sql.slice(sql.indexOf("CREATE OR REPLACE FUNCTION public.search_expenses"));
    expect(fn).toMatch(/SECURITY INVOKER/);
    expect(fn.slice(0, fn.indexOf("$fn$;"))).not.toMatch(/SECURITY DEFINER/);
    expect(fn).toMatch(/ORDER BY e\.created_at DESC, e\.id DESC/);
  });

  it.each([
    ["migration", migration],
    ["setup", setup],
  ])("%s: the category constraint matches EXPENSE_CATEGORIES", (_name, sql) => {
    const check = /expenses_category_check CHECK \(([\s\S]*?)\)\s*\)/.exec(sql);
    expect(check).not.toBeNull();
    const listed = [...check![1].matchAll(/'([a-z]+)'/g)].map((m) => m[1]).sort();
    expect(listed).toEqual([...EXPENSE_CATEGORIES].sort());
  });

  it("freezes the settlement asset alongside the amount on both provisioning paths", () => {
    for (const sql of [migration, setup]) {
      expect(sql).toContain("jsonb_build_object('settlement_asset', old_json -> 'settlement_asset')");
    }
  });

  it("normalizes tags in the database, not only in the client", () => {
    for (const sql of [migration, setup]) {
      expect(sql).toContain("CREATE TRIGGER trg_05_expenses_normalize_labels");
      expect(sql).toContain("NEW.tags := public.normalize_expense_tags(NEW.tags);");
    }
  });

  it("records migration 0008 in the cumulative setup path", () => {
    expect(setup).toContain(
      "('0008', '0008_expense_categories_tags_search', 'expense_categories_tags_search_v1')",
    );
  });
});
