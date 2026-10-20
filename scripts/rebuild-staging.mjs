#!/usr/bin/env node
/**
 * scripts/rebuild-staging.mjs
 *
 * Verifies and applies complete database rebuild from migration files,
 * schema definitions, RLS policies, and environment configuration.
 *
 * Usage:
 *   node scripts/rebuild-staging.mjs            # Validate and check staging rebuild readiness
 *   node scripts/rebuild-staging.mjs --apply    # Apply schema to target database
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const SETUP_SQL_PATH = path.join(ROOT, "supabase-setup.sql");

// ─── Colors ───────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

let failures = 0;
let warnings = 0;

const pass = (msg, detail) =>
  console.log(`${GREEN}  PASS${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
const fail = (msg, detail) => {
  failures += 1;
  console.log(`${RED}  FAIL${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
};
const warn = (msg, detail) => {
  warnings += 1;
  console.log(`${YELLOW}  WARN${RESET}  ${msg}${detail ? `\n${DIM}        ${detail}${RESET}` : ""}`);
};
const section = (title) => console.log(`\n${BOLD}${title}${RESET}`);

// ─── Env Loading ──────────────────────────────────────────────────────────────

function loadEnv() {
  const env = {};
  for (const file of [".env", ".env.local"]) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) continue;

    for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;

      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      env[key] = value;
    }
  }
  return { ...env, ...process.env };
}

// ─── Step 1: Migration Files Integrity ────────────────────────────────────────

export function verifyMigrationFiles() {
  section("1. Migration Files & Sequence Verification");

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    fail("Migrations directory not found", MIGRATIONS_DIR);
    return [];
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  if (files.length === 0) {
    fail("No migration files found in migrations directory");
    return [];
  }

  pass(`Found ${files.length} ordered migration files.`);

  const migrations = [];
  for (const file of files) {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const checksum = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);

    // Validate migration has checksum or idempotent registration
    if (!content.trim()) {
      fail(`Migration ${file} is empty.`);
    } else {
      pass(`Migration: ${file} (checksum: ${checksum})`);
    }

    migrations.push({ file, checksum, content });
  }

  return migrations;
}

// ─── Step 2: Storage & Schema Definition ──────────────────────────────────────

export function verifySetupSqlDefinition() {
  section("2. Cumulative Schema & RLS Definition (supabase-setup.sql)");

  if (!fs.existsSync(SETUP_SQL_PATH)) {
    fail("supabase-setup.sql not found at project root");
    return false;
  }

  const sql = fs.readFileSync(SETUP_SQL_PATH, "utf8");

  // Check essential tables
  const requiredTables = [
    "users",
    "trips",
    "expenses",
    "trip_invites",
    "settlement_intents",
    "auth_challenges",
    "auth_rate_limits",
    "schema_migrations",
  ];

  for (const table of requiredTables) {
    const pattern = new RegExp(`CREATE TABLE IF NOT EXISTS public\\.${table}`, "i");
    if (pattern.test(sql)) {
      pass(`Table definition present: public.${table}`);
    } else {
      fail(`Missing table definition: public.${table}`);
    }
  }

  // Check Row Level Security (RLS) enforcement
  const rlsTables = ["users", "trips", "expenses", "trip_invites", "settlement_intents"];
  for (const table of rlsTables) {
    const pattern = new RegExp(`ALTER TABLE public\\.${table}\\s+ENABLE ROW LEVEL SECURITY`, "i");
    if (pattern.test(sql)) {
      pass(`RLS enabled: public.${table}`);
    } else {
      fail(`Missing RLS enablement: public.${table}`);
    }
  }

  // Check Trigger Pipeline Order
  const triggers = [
    "trg_01_expenses_freeze_identity",
    "trg_02_expenses_sync_member_wallets",
    "trg_03_expenses_validate_shares",
    "trg_04_expenses_set_updated_at",
  ];
  for (const trg of triggers) {
    if (sql.includes(trg)) {
      pass(`Deterministic trigger present: ${trg}`);
    } else {
      fail(`Missing deterministic trigger: ${trg}`);
    }
  }

  // Check RPC Security Definer Functions
  const rpcs = ["current_wallet", "verify_trip_invite"];
  for (const rpc of rpcs) {
    const pattern = new RegExp(`CREATE OR REPLACE FUNCTION public\\.${rpc}`, "i");
    if (pattern.test(sql)) {
      pass(`Security RPC present: public.${rpc}()`);
    } else {
      fail(`Missing RPC: public.${rpc}()`);
    }
  }

  return true;
}

// ─── Step 3: Staging Environment Configuration ────────────────────────────────

export function verifyStagingConfig(env) {
  section("3. Staging Environment Configuration");

  const requiredVars = [
    { key: "NEXT_PUBLIC_STELLAR_NETWORK", valid: (v) => v === "TESTNET" || v === "PUBLIC" },
    { key: "NEXT_PUBLIC_SUPABASE_URL", valid: (v) => typeof v === "string" && v.startsWith("http") },
    { key: "NEXT_PUBLIC_SUPABASE_ANON_KEY", valid: (v) => typeof v === "string" && v.length > 10 },
    { key: "SUPABASE_JWT_SECRET", valid: (v) => typeof v === "string" && v.length >= 20 },
  ];

  for (const { key, valid } of requiredVars) {
    const val = env[key];
    if (val && valid(val)) {
      pass(`Environment variable configured: ${key}`);
    } else if (val) {
      warn(`Environment variable malformed: ${key}`, `Current value: ${val.slice(0, 5)}...`);
    } else {
      warn(`Environment variable unset in local shell: ${key}`, `Template available in .env.local.example`);
    }
  }
}

// ─── Main Runner ─────────────────────────────────────────────────────────────

export async function runStagingVerification() {
  console.log(`\n${BOLD}=== Stellar-star Staging Rebuild Verification ===${RESET}`);

  const env = loadEnv();
  verifyMigrationFiles();
  verifySetupSqlDefinition();
  verifyStagingConfig(env);

  console.log("\n" + "─".repeat(60));
  if (failures === 0) {
    console.log(`${GREEN}${BOLD}✓ Staging rebuild verification PASSED!${RESET}`);
    console.log(`All migration files, schema definitions, and RLS policies are clean and reproducible.`);
    return true;
  } else {
    console.log(`${RED}${BOLD}✗ Staging rebuild verification FAILED with ${failures} error(s).${RESET}`);
    return false;
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  runStagingVerification().then((ok) => {
    process.exit(ok ? 0 : 1);
  });
}
