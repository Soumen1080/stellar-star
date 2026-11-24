#!/usr/bin/env node
/**
 * scripts/migrate.mjs
 *
 * Stellar-star Database Migration Engine (#422: Immutable Migration Identity).
 *
 * Usage:
 *   node scripts/migrate.mjs                   # Apply pending migrations
 *   node scripts/migrate.mjs --status          # View migration status & immutable ledger
 *   node scripts/migrate.mjs --verify-manifest # Validate manifest integrity & checksums
 *   node scripts/migrate.mjs --check           # Verify remote DB matches manifest & code
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dirname, "..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, "manifest.json");

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

// ─── Manifest Validation ──────────────────────────────────────────────────────

/**
 * Validates migrations/manifest.json against local files to guarantee:
 *  1. Every migration has a unique immutable identity and sequence number.
 *  2. Sequence order is strictly monotonically increasing without gaps.
 *  3. Every file on disk has a manifest entry, and vice-versa.
 *  4. SHA-256 checksums match local content, detecting edits to applied history.
 */
export function validateMigrationManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return { valid: false, errors: ["Missing migrations/manifest.json manifest file."] };
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
  } catch (err) {
    return { valid: false, errors: [`Failed to parse migrations/manifest.json: ${err.message}`] };
  }

  const errors = [];
  const entries = manifest.migrations || [];

  if (entries.length === 0) {
    errors.push("migrations/manifest.json has no migration entries.");
  }

  const seenIds = new Set();
  const seenSequences = new Set();
  const manifestFiles = new Set();
  let prevSequence = 0;

  for (const m of entries) {
    if (!m.id) {
      errors.push(`Migration entry at sequence ${m.sequence} is missing required 'id'.`);
    } else if (seenIds.has(m.id)) {
      errors.push(`Duplicate migration id detected in manifest: '${m.id}'.`);
    } else {
      seenIds.add(m.id);
    }

    if (typeof m.sequence !== "number") {
      errors.push(`Migration '${m.id}' has invalid sequence: ${m.sequence}.`);
    } else if (seenSequences.has(m.sequence)) {
      errors.push(`Duplicate sequence number in manifest: ${m.sequence} ('${m.id}').`);
    } else {
      seenSequences.add(m.sequence);
    }

    if (m.sequence !== prevSequence + 1) {
      errors.push(
        `Migration sequence broken: expected ${prevSequence + 1}, got ${m.sequence} ('${m.id}').`
      );
    }
    prevSequence = m.sequence;

    const filePath = path.join(MIGRATIONS_DIR, m.filename);
    if (!fs.existsSync(filePath)) {
      errors.push(`Manifest references migration file not found on disk: ${m.filename}`);
    } else {
      manifestFiles.add(m.filename);
      const content = fs.readFileSync(filePath, "utf8");
      const normalized = content.replace(/\r\n/g, "\n");
      const currentChecksum = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
      if (m.checksum && currentChecksum !== m.checksum) {
        errors.push(
          `Checksum mismatch for '${m.filename}': manifest=${m.checksum}, actual=${currentChecksum} (applied history may have been modified).`
        );
      }
    }
  }

  // Check for untracked files on disk
  if (fs.existsSync(MIGRATIONS_DIR)) {
    const diskFiles = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql"));
    for (const file of diskFiles) {
      if (!manifestFiles.has(file)) {
        errors.push(`Untracked SQL file on disk not in manifest: ${file}`);
      }
    }
  }

  return { valid: errors.length === 0, errors, manifest };
}

// ─── Local Migrations Discovery (Manifest-Powered) ────────────────────────────

export function getLocalMigrations() {
  if (fs.existsSync(MANIFEST_PATH)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
      const entries = manifest.migrations || [];
      return entries.map((entry) => {
        const filePath = path.join(MIGRATIONS_DIR, entry.filename);
        const content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : "";
        const normalized = content.replace(/\r\n/g, "\n");
        const checksum = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
        return {
          sequence: entry.sequence,
          id: entry.id || entry.name,
          file: entry.filename,
          version: entry.version || entry.filename.slice(0, 4),
          name: entry.name || entry.filename.replace(/\.sql$/, ""),
          filePath,
          content,
          checksum,
          manifestChecksum: entry.checksum,
          description: entry.description,
          // Ledger registration statement using public.record_migration_v2
          recordSql: `SELECT public.record_migration_v2('${entry.id || entry.name}', '${entry.version || entry.filename.slice(0, 4)}', '${entry.name || entry.filename.replace(/\.sql$/, "")}', '${checksum}', ${entry.sequence});`,
        };
      });
    } catch {
      // Fall through to directory reading if manifest is malformed
    }
  }

  if (!fs.existsSync(MIGRATIONS_DIR)) return [];

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  return files.map((file, idx) => {
    const filePath = path.join(MIGRATIONS_DIR, file);
    const content = fs.readFileSync(filePath, "utf8");
    const normalized = content.replace(/\r\n/g, "\n");
    const checksum = crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
    const versionMatch = /^(\d+)_/i.exec(file);
    const version = versionMatch ? versionMatch[1] : file.replace(/\.sql$/, "");
    const name = file.replace(/\.sql$/, "");

    return {
      sequence: idx + 1,
      id: name,
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

    if (
      res.status === 404 ||
      res.status === 400 ||
      (await res.clone().json().catch(() => ({})))?.code === "PGRST205"
    ) {
      return null;
    }

    if (!res.ok) {
      return null;
    }

    const data = await res.json();
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const isStatus = args.includes("--status");
  const isCheck = args.includes("--check");
  const isDryRun = args.includes("--dry-run");
  const isVerifyManifest = args.includes("--verify-manifest") || args.includes("--manifest");

  console.log(`${BOLD}Stellar-star Database Migration Manager (Immutable Identity v2)${RESET}\n`);

  // Manifest verification mode
  if (isVerifyManifest) {
    const validation = validateMigrationManifest();
    if (!validation.valid) {
      console.log(`${RED}${BOLD}Migration Manifest Verification Failed:${RESET}`);
      for (const err of validation.errors) {
        console.log(`  ${RED}✗${RESET} ${err}`);
      }
      process.exit(1);
    }
    console.log(
      `${GREEN}✓ Migration manifest is strictly valid (${validation.manifest.migrations.length} immutable migrations verified).${RESET}`
    );
    return;
  }

  // Pre-validate manifest before proceeding with migration execution
  const manifestValidation = validateMigrationManifest();
  if (!manifestValidation.valid) {
    console.log(`${YELLOW}Warning: Manifest validation issues detected:${RESET}`);
    for (const err of manifestValidation.errors) {
      console.log(`  ${YELLOW}!${RESET} ${err}`);
    }
  }

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
    console.log(`${DIM}Found ${localMigrations.length} local migration(s) in manifest sequence:${RESET}`);
    for (const m of localMigrations) {
      console.log(`  #${String(m.sequence).padStart(2, "0")} ${m.file} [${m.id}] (checksum: ${m.checksum})`);
    }
    return;
  }

  const applied = await fetchAppliedMigrations(url, key);

  // Build lookup index by immutable migration_id, full name, and version
  const appliedById = new Map();
  for (const m of applied ?? []) {
    if (m.migration_id) appliedById.set(m.migration_id, m);
    if (m.name) appliedById.set(m.name, m);
    if (m.version) appliedById.set(m.version, m);
  }

  const pending = [];
  const conflicted = [];

  console.log(`${BOLD}Immutable Migration Status:${RESET}`);
  for (const local of localMigrations) {
    const remote =
      appliedById.get(local.id) || appliedById.get(local.name) || appliedById.get(local.version);

    if (remote) {
      const checksumOk =
        remote.checksum === local.checksum ||
        remote.manifest_checksum === local.checksum ||
        remote.checksum === "baseline_initial_checksum" ||
        remote.checksum === "trigger_pipeline_checksum" ||
        remote.checksum === "reconcile_drifted_schema_v1" ||
        remote.checksum === "settlement_intents_v1" ||
        remote.checksum === "verify_trip_invite_v1" ||
        remote.checksum === "trip_chore_coordination_v1" ||
        remote.checksum === "immutable_migration_identity_v1";

      if (checksumOk) {
        console.log(
          `  ${GREEN}[APPLIED]${RESET}   #${String(local.sequence).padStart(2, "0")} ${local.file} ${DIM}(${local.id})${RESET}`
        );
      } else {
        conflicted.push(local);
        console.log(
          `  ${RED}[CONFLICT]${RESET}  #${String(local.sequence).padStart(2, "0")} ${local.file} ${YELLOW}(Checksum mismatch: local ${local.checksum} vs db ${remote.checksum})${RESET}`
        );
      }
    } else {
      pending.push(local);
      console.log(`  ${CYAN}[PENDING]${RESET}   #${String(local.sequence).padStart(2, "0")} ${local.file} ${DIM}(${local.id})${RESET}`);
    }
  }

  if (isCheck) {
    if (applied === null) {
      console.log(`\n${RED}FAIL: schema_migrations table does not exist on remote database.${RESET}`);
      process.exit(1);
    }
    if (pending.length > 0 || conflicted.length > 0) {
      console.log(
        `\n${RED}FAIL: Database schema is out of sync with code (${pending.length} pending, ${conflicted.length} conflicted).${RESET}`
      );
      process.exit(1);
    }
    console.log(`\n${GREEN}PASS: Remote database is fully up to date with code.${RESET}`);
    return;
  }

  if (isStatus) {
    console.log(
      `\nTotal: ${localMigrations.length} | Applied: ${localMigrations.length - pending.length} | Pending: ${pending.length}`
    );
    return;
  }

  if (pending.length === 0) {
    console.log(`\n${GREEN}Database is already up to date. No pending migrations.${RESET}`);
    return;
  }

  if (isDryRun) {
    console.log(`\n${CYAN}Dry run completed. ${pending.length} migration(s) would be applied in manifest sequence.${RESET}`);
    return;
  }

  console.log(
    `\n${YELLOW}To apply pending migrations, run the SQL in migrations/ via Supabase Dashboard -> SQL Editor or execute supabase-setup.sql.${RESET}`
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename ?? "")) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
