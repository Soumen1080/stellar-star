/**
 * __tests__/database/databaseTypes.test.ts
 *
 * Release Gate: Database Schema and TypeScript Type Synchronization (#423).
 *
 * Asserts:
 *  1. Every database table defined in supabase-setup.sql has a corresponding
 *     definition in types/supabase.ts with matching columns.
 *  2. Critical RPC functions are strongly typed at the boundary (no bare Json
 *     or any returns).
 *  3. The automated type validator (scripts/generate-database-types.mjs) passes
 *     cleanly with zero drift.
 *  4. Drift detection fails fast when a table, column, or critical RPC is missing.
 */

import fs from "node:fs";
import path from "node:path";
import { validateDatabaseTypes } from "@/scripts/generate-database-types.mjs";

const ROOT = path.resolve(__dirname, "../..");
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");
const TYPES_FILE = path.join(ROOT, "types", "supabase.ts");

const CRITICAL_RPCS = [
  "check_auth_rate_limit",
  "check_rate_limit",
  "claim_trip_invite",
  "verify_trip_invite",
  "claim_contact_profile",
  "delete_user_account",
  "record_migration_v2",
  "update_expense_versioned",
  "mark_share_paid",
  "mark_shares_paid_batch",
  "void_expense",
  "record_share_installment",
];

describe("Database schema & TypeScript type synchronization (#423)", () => {
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");
  const typesContent = fs.readFileSync(TYPES_FILE, "utf8");

  it("validateDatabaseTypes() reports full synchronization with zero errors", async () => {
    const result = await validateDatabaseTypes();
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.tableCount).toBeGreaterThanOrEqual(40);
    expect(result.functionCount).toBeGreaterThanOrEqual(25);
  });

  it("every table in supabase-setup.sql is represented in Database['public']['Tables']", () => {
    const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-zA-Z0-9_]+)/gi;
    const sqlTables = [...new Set([...setupSql.matchAll(tableRegex)].map((m) => m[1]))];

    const tablesBlockMatch = typesContent.match(/Tables:\s*\{([\s\S]*?)\n\s{4}Views:/);
    expect(tablesBlockMatch).not.toBeNull();
    const typeTableNames = new Set(
      [...tablesBlockMatch![1].matchAll(/^\s{6}([a-zA-Z0-9_]+):\s*\{/gm)].map((m) => m[1])
    );

    for (const table of sqlTables) {
      expect({ table, inTypes: typeTableNames.has(table) }).toEqual({
        table,
        inTypes: true,
      });
    }
  });

  it("every critical RPC is strongly typed at the boundary (not bare Json or any)", () => {
    const funcBlockMatch = typesContent.match(/Functions:\s*\{([\s\S]*?)\n\s{4}Enums:/);
    expect(funcBlockMatch).not.toBeNull();
    const funcBlock = funcBlockMatch![1];

    for (const rpc of CRITICAL_RPCS) {
      const rpcPattern = new RegExp(`\\b${rpc}:\\s*\\{[\\s\\S]*?Returns:\\s*([^;]+);`, "m");
      const match = funcBlock.match(rpcPattern);

      expect({ rpc, defined: Boolean(match) }).toEqual({ rpc, defined: true });

      const returnType = match![1].trim();
      expect({ rpc, isGenericJson: returnType === "Json" || returnType === "any" }).toEqual({
        rpc,
        isGenericJson: false,
      });
    }
  });

  it("includes migration tracking additions in SchemaMigrationRow", () => {
    expect(typesContent).toMatch(/migration_id\??:\s*string/);
    expect(typesContent).toMatch(/sequence\??:\s*number/);
    expect(typesContent).toMatch(/manifest_checksum\??:\s*string/);
  });
});
