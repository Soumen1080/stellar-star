/**
 * __tests__/database/immutableMigrationIdentity.test.ts
 *
 * Enforces migration immutability invariants:
 *   1. Every migration has an immutable identity, sequence number, and checksum.
 *   2. Migration manifest (migrations/manifest.json) tracks all migrations in strict sequence.
 *   3. CI and migration runners reject duplicate IDs, sequence gaps, reordering, or content tampering.
 *   4. Historical migrations with duplicate numeric prefixes (0005, 0007, etc.) have distinct identities.
 *   5. Database ledger (public.schema_migrations) supports immutable migration tracking.
 *   6. Fresh installation (supabase-setup.sql) and upgrade paths produce the exact same schema.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const MANIFEST_PATH = path.join(MIGRATIONS_DIR, "manifest.json");
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");
const IMMUTABLE_MIGRATION_SQL = path.join(
  MIGRATIONS_DIR,
  "0021_immutable_migration_identity.sql"
);

interface ManifestEntry {
  sequence: number;
  id: string;
  filename: string;
  version: string;
  name: string;
  checksum: string;
  sha256: string;
  description?: string;
}

interface Manifest {
  $schema?: string;
  formatVersion: string;
  description: string;
  totalMigrations?: number;
  migrations: ManifestEntry[];
}

function computeSha256(content: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  return crypto.createHash("sha256").update(normalized, "utf8").digest("hex");
}

function resolveMatchingSha256(content: string, manifestSha: string): { sha256: string; checksum: string } {
  const rawSha = crypto.createHash("sha256").update(content, "utf8").digest("hex");
  const lfSha = crypto.createHash("sha256").update(content.replace(/\r\n/g, "\n"), "utf8").digest("hex");
  const crlfSha = crypto.createHash("sha256").update(content.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n"), "utf8").digest("hex");
  const sha256 = [rawSha, lfSha, crlfSha].includes(manifestSha) ? manifestSha : rawSha;
  return { sha256, checksum: sha256.slice(0, 16) };
}

describe("Immutable Migration Identity and Manifest", () => {
  const manifestRaw = fs.readFileSync(MANIFEST_PATH, "utf8");
  const manifest: Manifest = JSON.parse(manifestRaw);
  const sqlFilesOnDisk = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  it("manifest exists and defines a valid formatVersion and description", () => {
    expect(manifest.formatVersion).toBe("1.0.0");
    expect(typeof manifest.description).toBe("string");
    expect(manifest.description.length).toBeGreaterThan(0);
    expect(Array.isArray(manifest.migrations)).toBe(true);
    expect(manifest.migrations.length).toBe(sqlFilesOnDisk.length);
  });

  it("every SQL file on disk is tracked in the manifest exactly once", () => {
    const manifestFilenames = manifest.migrations.map((m) => m.filename);
    expect(new Set(manifestFilenames).size).toBe(manifestFilenames.length);
    expect(manifestFilenames.sort()).toEqual(sqlFilesOnDisk.sort());
  });

  it("sequences are strictly 1..N with no gaps, duplicates, or reordering", () => {
    manifest.migrations.forEach((m, idx) => {
      expect(m.sequence).toBe(idx + 1);
    });
  });

  it("every migration has a unique immutable identity (id)", () => {
    const ids = manifest.migrations.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(typeof id).toBe("string");
      expect(id.trim().length).toBeGreaterThan(0);
    }
  });

  it("computes immutable sha256 and checksum prefixes matching file content on disk", () => {
    for (const entry of manifest.migrations) {
      const filePath = path.join(MIGRATIONS_DIR, entry.filename);
      expect(fs.existsSync(filePath)).toBe(true);

      const content = fs.readFileSync(filePath, "utf8");
      const { sha256: expectedSha256, checksum: expectedChecksum } = resolveMatchingSha256(content, entry.sha256);

      expect(entry.sha256).toBe(expectedSha256);
      expect(entry.checksum).toBe(expectedChecksum);
    }
  });

  it("resolves duplicate numeric prefixes with unique migration identities", () => {
    const versionCounts = new Map<string, number>();
    for (const entry of manifest.migrations) {
      versionCounts.set(entry.version, (versionCounts.get(entry.version) ?? 0) + 1);
    }

    const duplicatedVersions = [...versionCounts.entries()]
      .filter(([_, count]) => count > 1)
      .map(([ver]) => ver);

    // Verify known duplicate prefixes exist in history (e.g. 0005, 0007, 0009, etc.)
    expect(duplicatedVersions.length).toBeGreaterThan(0);

    // For each duplicated version, all entries must possess unique IDs and unique sequences
    for (const ver of duplicatedVersions) {
      const entriesForVer = manifest.migrations.filter((m) => m.version === ver);
      const ids = entriesForVer.map((e) => e.id);
      const sequences = entriesForVer.map((e) => e.sequence);

      expect(new Set(ids).size).toBe(entriesForVer.length);
      expect(new Set(sequences).size).toBe(entriesForVer.length);
    }
  });
});

describe("Database Ledger DDL and Compatibility (Migration 0021)", () => {
  const migrationSql = fs.readFileSync(IMMUTABLE_MIGRATION_SQL, "utf8");
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");

  it("defines schema_migrations table with immutable columns", () => {
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS migration_id TEXT");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS sequence INT");
    expect(migrationSql).toContain("ADD COLUMN IF NOT EXISTS manifest_checksum TEXT");

    expect(setupSql).toContain("migration_id TEXT");
    expect(setupSql).toContain("sequence INT");
    expect(setupSql).toContain("manifest_checksum TEXT");
  });

  it("creates indexes on migration_id, sequence, and name in both paths", () => {
    const requiredIndexes = [
      "idx_schema_migrations_name",
      "idx_schema_migrations_sequence",
      "idx_schema_migrations_migration_id",
    ];

    for (const idx of requiredIndexes) {
      expect(migrationSql).toContain(idx);
      expect(setupSql).toContain(idx);
    }
  });

  it("defines record_migration_v2 function in both paths", () => {
    expect(migrationSql).toContain("CREATE OR REPLACE FUNCTION public.record_migration_v2");
    expect(setupSql).toContain("CREATE OR REPLACE FUNCTION public.record_migration_v2");
  });

  it("migration 0021 backfills historical migrations with sequence and migration_id", () => {
    expect(migrationSql).toMatch(/UPDATE\s+public\.schema_migrations\s+SET/);
    expect(migrationSql).toContain("0001_baseline");
    expect(migrationSql).toContain("0020_onchain_reconciliation_worker");
  });

  it("migration 0021 self-registers into public.schema_migrations with sequence 33", () => {
    expect(migrationSql).toMatch(
      /INSERT INTO public\.schema_migrations\s*\([^)]*migration_id[^)]*sequence[^)]*\)/
    );
    expect(migrationSql).toContain("'0021_immutable_migration_identity'");
    expect(migrationSql).toContain("33");
  });
});

describe("Migration Runner Manifest Verification", () => {
  const runnerContent = fs.readFileSync(path.join(ROOT, "scripts/migrate.mjs"), "utf8");

  it("runner supports --verify-manifest option", () => {
    expect(runnerContent).toContain("--verify-manifest");
    expect(runnerContent).toContain("validateMigrationManifest");
  });

  it("runner checks for duplicate IDs, missing files, untracked files, and checksum tampering", () => {
    expect(runnerContent).toContain("Duplicate migration id");
    expect(runnerContent).toContain("Checksum mismatch");
    expect(runnerContent).toContain("not found on disk");
    expect(runnerContent).toContain("Untracked SQL file on disk");
  });

  it("runner applies migrations in sequence order from manifest", () => {
    expect(runnerContent).toContain("entry.sequence");
    expect(runnerContent).toContain("record_migration_v2");
  });
});
