/**
 * __tests__/database/schemaDrift.test.ts
 *
 * Guards the invariant that makes the migration system worth having:
 *
 *   "An existing production database converges to the same schema as a fresh
 *    one."
 *
 * There are two provisioning paths — pasting supabase-setup.sql, and running
 * migrations/*.sql in order. If an object exists on only one path, the two
 * paths produce different databases and the version number stops meaning
 * anything.
 *
 * This is not hypothetical. Commits 0823a9e and dad56b6 added auth challenge
 * storage, auth rate limiting, and the optimistic-concurrency RPCs directly to
 * supabase-setup.sql with no migration. A database built from migrations was
 * missing functions the application calls at runtime, and nothing failed until
 * it was called. Migration 0003 reconciled them; this test stops it recurring.
 *
 * It is a static analysis of the SQL text, not a live database check — that is
 * `npm run db:check`. The point is to fail in CI, before anyone deploys.
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "../..");
const MIGRATIONS_DIR = path.join(ROOT, "migrations");
const SETUP_SQL = path.join(ROOT, "supabase-setup.sql");

/** Strips comments so a name mentioned in prose is never read as a definition. */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

/**
 * Extracts the durable schema objects a database must have.
 *
 * Policies and triggers are deliberately excluded: the setup file drops and
 * recreates them wholesale, so their text differs between the two paths by
 * design. Trigger ordering has its own dedicated test.
 */
function extractObjects(sql: string): Set<string> {
  const clean = stripComments(sql);
  const found = new Set<string>();

  const patterns: Array<[RegExp, string]> = [
    [/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi, "table"],
    [/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)/gi, "function"],
    [/CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?([\w.]+)/gi, "index"],
  ];

  for (const [re, kind] of patterns) {
    for (const match of clean.matchAll(re)) {
      found.add(`${kind}:${match[1].replace(/^public\./, "").toLowerCase()}`);
    }
  }
  return found;
}

function readMigrationFiles(): { name: string; sql: string }[] {
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((name) => ({
      name,
      sql: fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8"),
    }));
}

describe("schema drift between provisioning paths", () => {
  const migrations = readMigrationFiles();
  const migrationSql = migrations.map((m) => m.sql).join("\n");
  const setupSql = fs.readFileSync(SETUP_SQL, "utf8");

  it("REGRESSION: every object in supabase-setup.sql exists in some migration", () => {
    const inSetup = extractObjects(setupSql);
    const inMigrations = extractObjects(migrationSql);

    const missing = [...inSetup].filter((o) => !inMigrations.has(o)).sort();

    // A non-empty list means a fresh migration-built database is missing
    // something the setup file creates — the exact drift #205 exists to stop.
    expect({ missing }).toEqual({ missing: [] });
  });

  it("does not create objects in migrations that the setup file lacks", () => {
    const inSetup = extractObjects(setupSql);
    const inMigrations = extractObjects(migrationSql);

    // schema_migrations is the tracking table itself: it is created by the
    // migration runner and has no reason to exist in the paste-once file.
    const expected = new Set(["table:schema_migrations"]);
    const extra = [...inMigrations].filter((o) => !inSetup.has(o) && !expected.has(o)).sort();

    expect({ extra }).toEqual({ extra: [] });
  });
});

describe("migration hygiene", () => {
  const migrations = readMigrationFiles();

  it("numbers every migration uniquely, so parallel contributors collide loudly", () => {
    const versions = migrations.map((m) => m.name.slice(0, 4));
    // Two contributors both adding "0004_*" is a merge conflict here rather
    // than a silent divergence in what each database actually ran.
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("records its own version, so a partially applied run is detectable", () => {
    for (const { name, sql } of migrations) {
      const version = name.slice(0, 4);
      expect({ name, records: sql.includes("INSERT INTO public.schema_migrations") }).toEqual({
        name,
        records: true,
      });
      expect({ name, version: sql.includes(`'${version}'`) }).toEqual({ name, version: true });
    }
  });

  it("uses ON CONFLICT DO NOTHING so re-running is a no-op, not an error", () => {
    for (const { name, sql } of migrations) {
      expect({ name, idempotent: /ON\s+CONFLICT\s*\(version\)\s*DO\s+NOTHING/i.test(sql) }).toEqual(
        { name, idempotent: true },
      );
    }
  });

  it("guards every CREATE POLICY with a preceding DROP, so re-running does not fail", () => {
    for (const { name, sql } of migrations) {
      const clean = stripComments(sql);
      const lines = clean.split("\n");
      const unguarded: string[] = [];

      lines.forEach((line, i) => {
        const m = line.trim().match(/^CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+([\w.]+)/i);
        if (!m) return;
        const preceding = lines
          .slice(0, i)
          .reverse()
          .find((l) => l.trim() !== "");
        if (!/^DROP\s+POLICY\s+IF\s+EXISTS/i.test((preceding ?? "").trim())) {
          unguarded.push(`${m[1]} on ${m[2]}`);
        }
      });

      expect({ name, unguarded }).toEqual({ name, unguarded: [] });
    }
  });

  it("contains no destructive statements outside a documented rollback", () => {
    for (const { name, sql } of migrations) {
      const clean = stripComments(sql);
      // DROP TABLE / DROP COLUMN lose data. Migrations here must converge an
      // existing database without data loss.
      expect({ name, destructive: /DROP\s+TABLE(?!\s+IF\s+EXISTS\s+public\.schema_migrations)/i.test(clean) })
        .toEqual({ name, destructive: false });
      expect({ name, dropsColumn: /DROP\s+COLUMN/i.test(clean) }).toEqual({
        name,
        dropsColumn: false,
      });
    }
  });
});
