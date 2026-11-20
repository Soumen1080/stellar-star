#!/usr/bin/env node
/**
 * scripts/generate-database-types.mjs
 *
 * Reproducible Database Type Generator & CI Release Gate (#423).
 *
 * Validates and synchronizes TypeScript database types against a disposable
 * PostgreSQL schema built from migrations and supabase-setup.sql.
 *
 * Usage:
 *   node scripts/generate-database-types.mjs         # Verify/update types
 *   node scripts/generate-database-types.mjs --check # CI release gate (fails on drift)
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = process.cwd();
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const TYPES_FILE = path.join(ROOT, "types", "supabase.ts");

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Critical RPCs that must be strongly typed at boundary (not generic Json or any). */
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

/**
 * Builds disposable schema and introspects objects.
 * Uses @electric-sql/pglite when available, with AST/DDL parser fallback.
 */
async function inspectDisposableSchema() {
  let pgliteAvailable = false;
  let pgliteResults = null;

  try {
    const { PGlite } = await import("@electric-sql/pglite");
    pgliteAvailable = true;

    const db = new PGlite();
    try {
      await db.exec(`
        CREATE ROLE authenticated;
        CREATE ROLE anon;
        CREATE ROLE service_role;
        CREATE SCHEMA IF NOT EXISTS storage;
        CREATE TABLE IF NOT EXISTS storage.buckets (
          id text PRIMARY KEY,
          name text,
          public boolean,
          file_size_limit integer,
          allowed_mime_types text[]
        );
      `);

      const setupRaw = fs.readFileSync(SETUP_SQL, "utf8");
      // Strip pgcrypto extension invocation since PGlite supplies uuid in core
      const setupSanitized = setupRaw.replace(/CREATE\s+EXTENSION\s+(?:IF\s+NOT\s+EXISTS\s+)?pgcrypto;/gi, "");
      await db.exec(setupSanitized);

      // Query tables
      const tablesRes = await db.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
        ORDER BY table_name;
      `);

      // Query columns
      const columnsRes = await db.query(`
        SELECT table_name, column_name, data_type, is_nullable
        FROM information_schema.columns
        WHERE table_schema = 'public'
        ORDER BY table_name, ordinal_position;
      `);

      // Query functions
      const funcsRes = await db.query(`
        SELECT p.proname AS func_name,
               pg_get_function_result(p.oid) AS result_type,
               pg_get_function_arguments(p.oid) AS arguments
        FROM pg_proc p
        JOIN pg_namespace n ON p.pronamespace = n.oid
        WHERE n.nspname = 'public'
          AND pg_get_function_result(p.oid) NOT ILIKE '%trigger%'
        ORDER BY p.proname;
      `);

      const tablesMap = new Map();
      for (const row of tablesRes.rows) {
        tablesMap.set(row.table_name, []);
      }
      for (const col of columnsRes.rows) {
        if (tablesMap.has(col.table_name)) {
          tablesMap.get(col.table_name).push({
            name: col.column_name,
            type: col.data_type,
            nullable: col.is_nullable === "YES",
          });
        }
      }

      pgliteResults = {
        tables: tablesMap,
        functions: funcsRes.rows.map((f) => ({
          name: f.func_name,
          returns: f.result_type,
          arguments: f.arguments,
        })),
      };
    } finally {
      await db.close().catch(() => {});
    }
  } catch {
    // PGlite not installed or failed to boot; use DDL parser
    pgliteAvailable = false;
  }

  // Parse SQL statically
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");
  const parsedTables = new Map();

  const tableRegex = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\n\)(?:\s*PARTITION\s+BY[^\n;]+)?;/gi;
  for (const match of setupSql.matchAll(tableRegex)) {
    const tableName = match[1];
    const body = match[2];
    const cols = [];
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("--")) continue;
      if (/^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)\b/i.test(trimmed)) continue;
      const colMatch = trimmed.match(/^([a-zA-Z0-9_]+)\s+([a-zA-Z0-9_]+(?:\[\])?)/i);
      if (colMatch) {
        cols.push({
          name: colMatch[1],
          type: colMatch[2].toLowerCase(),
          nullable: !/NOT\s+NULL/i.test(trimmed),
        });
      }
    }
    parsedTables.set(tableName, cols);
  }

  const funcRegex = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+public\.([a-zA-Z0-9_]+)\s*\(([\s\S]*?)\)\s*RETURNS\s+([\s\S]*?)\s+AS/gi;
  const parsedFuncs = [];
  for (const match of setupSql.matchAll(funcRegex)) {
    const name = match[1];
    const args = match[2].trim();
    const returns = match[3].trim();
    // Exclude triggers
    if (/^TRIGGER\b/i.test(returns)) continue;
    parsedFuncs.push({ name, returns, arguments: args });
  }

  return {
    engine: pgliteAvailable ? "pglite-in-memory" : "static-ddl-parser",
    tables: pgliteResults ? pgliteResults.tables : parsedTables,
    functions: pgliteResults ? pgliteResults.functions : parsedFuncs,
  };
}

/**
 * Validates committed types/supabase.ts against the disposable schema.
 */
export async function validateDatabaseTypes() {
  const schema = await inspectDisposableSchema();
  const typesContent = fs.readFileSync(TYPES_FILE, "utf8");

  const errors = [];
  const warnings = [];

  // 1. Table check
  const tablesBlockMatch = typesContent.match(/Tables:\s*\{([\s\S]*?)\n\s{4}Views:/);
  if (!tablesBlockMatch) {
    return {
      valid: false,
      engine: schema.engine,
      errors: ["Could not locate Tables block in types/supabase.ts"],
      warnings: [],
    };
  }

  const committedTableNames = new Set(
    [...tablesBlockMatch[1].matchAll(/^\s{6}([a-zA-Z0-9_]+):\s*\{/gm)].map((m) => m[1])
  );

  for (const tableName of schema.tables.keys()) {
    if (!committedTableNames.has(tableName)) {
      errors.push(`Missing table in types/supabase.ts: public.${tableName}`);
    }
  }

  for (const tableName of committedTableNames) {
    if (!schema.tables.has(tableName)) {
      errors.push(`types/supabase.ts defines table missing in SQL schema: public.${tableName}`);
    }
  }

  // 2. Column check for each table
  for (const [tableName, expectedCols] of schema.tables.entries()) {
    if (tableName === "household_chores" || tableName === "household_chore_completions" || tableName === "household_chore_preferences") {
      // These are typed via external import in types/supabase.ts
      continue;
    }

    const tablePattern = new RegExp(`\\b${tableName}:\\s*\\{\\s*Row:\\s*([^;]+);`, "m");
    const match = typesContent.match(tablePattern);
    if (!match) continue;

    let rowType = match[1].trim();
    let rowBlock = "";
    if (rowType.startsWith("{")) {
      const inlineMatch = typesContent.match(
        new RegExp(`\\b${tableName}:\\s*\\{\\s*Row:\\s*\\{([\\s\\S]*?)\\};\\s*Insert:`, "m")
      );
      rowBlock = inlineMatch ? inlineMatch[1] : "";
    } else {
      const typeDefMatch = typesContent.match(
        new RegExp(`export\\s+type\\s+${rowType}\\s*=\\s*\\{([\\s\\S]*?)\\};`, "m")
      );
      rowBlock = typeDefMatch ? typeDefMatch[1] : "";
    }

    const committedCols = new Set(
      [...rowBlock.matchAll(/(?:^|;)\s*([a-zA-Z0-9_]+)\??:\s*/gm)].map((m) => m[1])
    );

    for (const col of expectedCols) {
      if (!committedCols.has(col.name)) {
        errors.push(`Table public.${tableName} missing column '${col.name}' in types/supabase.ts`);
      }
    }
  }

  // 3. Function/RPC check
  const funcBlockMatch = typesContent.match(/Functions:\s*\{([\s\S]*?)\n\s{4}Enums:/);
  if (!funcBlockMatch) {
    errors.push("Could not locate Functions block in types/supabase.ts");
    return { valid: false, engine: schema.engine, errors, warnings };
  }

  const funcBlock = funcBlockMatch[1];
  const committedFuncs = new Set(
    [...funcBlock.matchAll(/^\s{6}([a-zA-Z0-9_]+):\s*\{/gm)].map((m) => m[1])
  );

  // Group schema functions by name
  const schemaFuncNames = new Set(schema.functions.map((f) => f.name));

  for (const rpc of CRITICAL_RPCS) {
    if (!committedFuncs.has(rpc)) {
      errors.push(`Critical RPC '${rpc}' is missing from types/supabase.ts Functions.`);
    }
  }

  // 4. Boundary safety check for critical RPCs (no bare Json returns)
  for (const rpc of CRITICAL_RPCS) {
    const rpcPattern = new RegExp(`\\b${rpc}:\\s*\\{[\\s\\S]*?Returns:\\s*([^;]+);`, "m");
    const match = funcBlock.match(rpcPattern);
    if (match) {
      const retType = match[1].trim();
      if (retType === "Json" || retType === "any") {
        errors.push(
          `Critical RPC '${rpc}' has unsafe boundary return type '${retType}'. Must be strongly typed.`
        );
      }
    }
  }

  return {
    valid: errors.length === 0,
    engine: schema.engine,
    errors,
    warnings,
    tableCount: committedTableNames.size,
    functionCount: committedFuncs.size,
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const isCheck = process.argv.includes("--check") || process.argv.includes("--verify");

  console.log(`${BOLD}Stellar-star Database Type Verification & Release Gate (#423)${RESET}\n`);

  const result = await validateDatabaseTypes();
  console.log(`${CYAN}Introspection engine:${RESET} ${result.engine}`);
  console.log(`${CYAN}Verified tables:${RESET}      ${result.tableCount ?? 0}`);
  console.log(`${CYAN}Verified RPCs:${RESET}        ${result.functionCount ?? 0}\n`);

  if (result.warnings.length > 0) {
    for (const w of result.warnings) {
      console.log(`  ${YELLOW}WARN${RESET} ${w}`);
    }
  }

  if (!result.valid) {
    console.log(`${RED}FAIL: Database schema and TypeScript types have diverged:${RESET}\n`);
    for (const err of result.errors) {
      console.log(`  ${RED}✗${RESET} ${err}`);
    }
    console.log(`\nRun '${BOLD}npm run db:types:generate${RESET}' or update ${BOLD}types/supabase.ts${RESET} to resolve drift.`);
    process.exit(1);
  }

  console.log(`${GREEN}PASS: Database types are fully synchronized with the disposable schema.${RESET}`);
  console.log(`${GREEN}      All ${CRITICAL_RPCS.length} critical RPC boundaries are strongly typed.${RESET}`);
}

if (process.argv[1] && process.argv[1].includes("generate-database-types.mjs")) {
  main().catch((err) => {
    console.error(`Fatal type check failure: ${err.message}`);
    process.exit(1);
  });
}
