/**
 * __tests__/database/deadlinesMigration.test.ts
 *
 * Migration verification for Database Deadlines and Query Budgets (#421).
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const migrationFile = path.join(
  ROOT,
  "migrations/0021_database_deadlines_and_query_budgets.sql"
);
const setupFile = path.join(ROOT, "supabase-setup.sql");

describe("Migration 0021: Database Deadlines and Query Budgets", () => {
  const migrationSql = fs.readFileSync(migrationFile, "utf8");
  const setupSql = fs.readFileSync(setupFile, "utf8");

  it("exists and defines public.database_query_traces table", () => {
    expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS public.database_query_traces");
    expect(setupSql).toContain("CREATE TABLE IF NOT EXISTS public.database_query_traces");
  });

  it("creates required composite indexes for route and status filtering", () => {
    const expectedIndexes = [
      "idx_database_query_traces_route_created",
      "idx_database_query_traces_status_created",
      "idx_database_query_traces_request_id",
      "idx_database_query_traces_created_at",
    ];

    for (const idx of expectedIndexes) {
      expect(migrationSql).toContain(idx);
      expect(setupSql).toContain(idx);
    }
  });

  it("defines statement, lock, and idle-in-transaction timeout procedures", () => {
    expect(migrationSql).toContain("public.set_session_deadlines");
    expect(migrationSql).toContain("SET LOCAL statement_timeout");
    expect(migrationSql).toContain("SET LOCAL lock_timeout");
    expect(migrationSql).toContain("SET LOCAL idle_in_transaction_session_timeout");

    expect(setupSql).toContain("public.set_session_deadlines");
  });

  it("defines bounded query trace recording and pruning functions", () => {
    expect(migrationSql).toContain("public.record_database_trace");
    expect(migrationSql).toContain("public.prune_database_query_traces");
    expect(setupSql).toContain("public.record_database_trace");
    expect(setupSql).toContain("public.prune_database_query_traces");
  });

  it("enforces Row Level Security (RLS) and guards policy recreation", () => {
    expect(migrationSql).toContain("ALTER TABLE public.database_query_traces ENABLE ROW LEVEL SECURITY");
    expect(migrationSql).toContain("DROP POLICY IF EXISTS database_query_traces_select_auth");
    expect(migrationSql).toContain("CREATE POLICY database_query_traces_select_auth");
    expect(migrationSql).toContain("DROP POLICY IF EXISTS database_query_traces_insert_auth");
    expect(migrationSql).toContain("CREATE POLICY database_query_traces_insert_auth");
  });

  it("records version 0021 in public.schema_migrations ledger idempotently", () => {
    expect(migrationSql).toMatch(
      /INSERT INTO public\.schema_migrations\s*\(version,\s*name,\s*checksum\)\s*VALUES\s*\('0021',\s*'0021_database_deadlines_and_query_budgets'/i
    );
    expect(migrationSql).toMatch(/ON\s+CONFLICT\s*\(version\)\s*DO\s+NOTHING/i);

    expect(setupSql).toMatch(
      /INSERT INTO public\.schema_migrations\s*\(version,\s*name,\s*checksum\)\s*VALUES\s*\('0021',\s*'0021_database_deadlines_and_query_budgets'/i
    );
  });

  it("contains query plan fixtures and rollback documentation in SQL comments", () => {
    expect(migrationSql).toContain("EXPLAIN ANALYZE");
    expect(migrationSql).toContain("Index Scan using idx_database_query_traces_route_created");
    expect(migrationSql).toContain("Rollback Instructions:");
  });
});
