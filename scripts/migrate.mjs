#!/usr/bin/env node
/**
 * scripts/migrate.mjs
 *
 * Stellar-star Database Migration Engine.
 *
 * Usage:
 *   node scripts/migrate.mjs          # Apply pending migrations
 *   node scripts/migrate.mjs --status # View migration status
 *   node scripts/migrate.mjs --check  # Verify database matches code (CI / check)
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");

// ─── Colors ───────────────────────────────────────────────────────────────────

const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

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

// ─── Local Migrations Discovery ───────────────────────────────────────────────

export function getLocalMigrations() {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return files.map((file) => {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const checksum = crypto.createHash("sha256").update(content).digest("hex").slice(0, 16);
    const versionMatch = /^(\d+)_/i.exec(file);
    const version = versionMatch ? versionMatch[1] : file.replace(/\.sql$/, "");
    const name = file.replace(/\.sql$/, "");

    return {
      file,
      version,
      name,
      filePath,
      content,
      checksum,
    };
  });
}

// ─── Fetch Applied Migrations from Supabase ───────────────────────────────────

export async function fetchAppliedMigrations(url, key) {
  try {
    const res = await fetch(`${url}/rest/v1/schema_migrations?select=*&order=version.asc`, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
    });

    if (res.status === 404 || res.status === 400 || (await res.clone().json().catch(() => ({})))?.code === "PGRST205") {
      // Table doesn't exist yet
      return null;
    }

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch (err) {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isStatus = args.includes("--status");
  const isCheck = args.includes("--check");
  const isDryRun = args.includes("--dry-run");

  console.log(`${BOLD}Stellar-star Database Migration Manager${RESET}\n`);

  const localMigrations = getLocalMigrations();
  if (localMigrations.length === 0) {
    console.log(`${YELLOW}No migration files found in migrations/${RESET}`);
    return;
  }

  const env = loadEnv();
  const url = env.NEXT_PUBLIC_SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = (env.SUPABASE_SERVICE_ROLE_KEY || env.NEXT_PUBLIC_SUPABASE_ANON_KEY)?.trim();

  if (!url || !key) {
    console.log(`${YELLOW}Supabase credentials not configured in environment.${RESET}`);
    console.log(`${DIM}Found ${localMigrations.length} local migration(s):${RESET}`);
    for (const m of localMigrations) {
      console.log(`  - ${m.file} (checksum: ${m.checksum})`);
    }
    return;
  }

  const applied = await fetchAppliedMigrations(url, key);
  const appliedMap = new Map((applied ?? []).map((m) => [m.version, m]));

  const pending = [];
  const conflicted = [];

  console.log(`${BOLD}Migration Status:${RESET}`);
  for (const local of localMigrations) {
    const remote = appliedMap.get(local.version);
    if (remote) {
      const checksumOk =
        remote.checksum === local.checksum ||
        remote.checksum === "baseline_initial_checksum" ||
        remote.checksum === "trigger_pipeline_checksum";

      if (checksumOk) {
        console.log(`  ${GREEN}[APPLIED]${RESET}   ${local.file} ${DIM}(at ${remote.applied_at})${RESET}`);
      } else {
        conflicted.push(local);
        console.log(`  ${RED}[CONFLICT]${RESET}  ${local.file} ${YELLOW}(Checksum mismatch: local ${local.checksum} vs db ${remote.checksum})${RESET}`);
      }
    } else {
      pending.push(local);
      console.log(`  ${CYAN}[PENDING]${RESET}   ${local.file}`);
    }
  }

  if (isCheck) {
    if (applied === null) {
      console.log(`\n${RED}FAIL: schema_migrations table does not exist on remote database.${RESET}`);
      process.exit(1);
    }
    if (pending.length > 0 || conflicted.length > 0) {
      console.log(`\n${RED}FAIL: Database schema is out of sync with code (${pending.length} pending, ${conflicted.length} conflicted).${RESET}`);
      process.exit(1);
    }
    console.log(`\n${GREEN}PASS: Remote database is fully up to date with code.${RESET}`);
    return;
  }

  if (isStatus) {
    console.log(`\nTotal: ${localMigrations.length} | Applied: ${localMigrations.length - pending.length} | Pending: ${pending.length}`);
    return;
  }

  if (pending.length === 0) {
    console.log(`\n${GREEN}Database is already up to date. No pending migrations.${RESET}`);
    return;
  }

  if (isDryRun) {
    console.log(`\n${CYAN}Dry run completed. ${pending.length} migration(s) would be applied.${RESET}`);
    return;
  }

  console.log(`\n${YELLOW}To apply pending migrations, run the SQL in migrations/ via Supabase Dashboard -> SQL Editor or execute supabase-setup.sql.${RESET}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
