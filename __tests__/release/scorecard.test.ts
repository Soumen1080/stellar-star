/**
 * __tests__/release/scorecard.test.ts
 *
 * Release readiness scorecard (#447): failed requirements block promotion,
 * accountable exceptions are validated before they apply, and every decision,
 * its evidence digests and its overrides land in a tamper-evident audit log.
 */

import fs from "node:fs";
import path from "node:path";
import {
  RELEASE_DOMAINS,
  buildAuditRecord,
  evaluateAssertion,
  evaluateScorecard,
  findTablesWithoutRls,
  lastAuditHash,
  sha256,
  validateException,
  validatePolicy,
  verifyAuditLog,
  type ReadinessPolicy,
  type ReleaseException,
  type ReleaseFs,
  type Requirement,
} from "@/lib/release/scorecard";

const NOW = new Date("2026-11-22T12:00:00.000Z");
const ROOT = path.resolve(__dirname, "../..");

function memoryFs(files: Record<string, string>): ReleaseFs {
  return {
    read: (p) => (p in files ? files[p] : null),
    list: (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(dir + "/") && !f.slice(dir.length + 1).includes("/"))
        .map((f) => f.slice(dir.length + 1)),
  };
}

function evidence(name: string, data: unknown, collectedAt = "2026-11-22T06:00:00.000Z") {
  return JSON.stringify({ name, collectedAt, source: "test", data });
}

const MIGRATION_SQL = "-- Rollback: forward-only\nSELECT 1;\n";

function baseFiles(): Record<string, string> {
  return {
    "migrations/0001_a.sql": MIGRATION_SQL,
    "migrations/manifest.json": JSON.stringify({
      migrations: [{ sequence: 1, id: "0001_a", filename: "0001_a.sql", sha256: sha256(MIGRATION_SQL) }],
    }),
    "schema.sql": "CREATE TABLE public.trips (id uuid);\nALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;\n",
    "plan.json": JSON.stringify({ fixtures: [{ name: "p", plan: { outer: "Index Scan using trips_pkey" } }] }),
    "audit.md": "| **SEC-F01** | x | P0 | y | **FIXED** |\n",
    "package.json": JSON.stringify({ dependencies: { a: "^1.0.0" } }),
    "package-lock.json": JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/a": { version: "1.0.0", integrity: "sha512-x" } },
    }),
    "runbook.md": "## 7. Rollback\n",
    "ev/npm-audit.json": evidence("npm-audit", { metadata: { vulnerabilities: { critical: 0, high: 0 } } }),
    "ev/slos.json": evidence("slos", { availability: 0.9995 }),
    "ev/backup-snapshot.json": evidence("backup-snapshot", { lastSuccessfulBackupAt: "2026-11-22T02:00:00.000Z" }),
  };
}

function req(id: string, domain: Requirement["domain"], check: Requirement["check"], overridable = true): Requirement {
  return { id, domain, title: id, owner: "@owner", blocking: true, overridable, check };
}

function basePolicy(): ReadinessPolicy {
  return {
    version: "test",
    evidenceDir: "ev",
    maxExceptionDays: 14,
    approvers: { slos: ["@sre-lead"], rls: ["@security-lead"] },
    requirements: [
      req("MIG", "migrations", { type: "migration-manifest", dir: "migrations", manifest: "migrations/manifest.json" }, false),
      req("RLS", "rls", { type: "rls-enabled", schemaFile: "schema.sql" }, false),
      req("PERF", "performance", { type: "query-plan-fixtures", files: ["plan.json"] }),
      req("SEC", "security", { type: "line-rules", file: "audit.md", lineMatches: "^\\|\\s*\\*\\*SEC-F", mustMatch: "\\*\\*FIXED\\*\\*" }),
      req("BAK", "backups", {
        type: "evidence",
        name: "backup-snapshot",
        maxAgeDays: 2,
        assertions: [{ path: "data.lastSuccessfulBackupAt", op: "maxAgeHours", value: 26 }],
      }),
      req("DEP", "dependencies", {
        type: "evidence",
        name: "npm-audit",
        maxAgeDays: 1,
        assertions: [{ path: "data.metadata.vulnerabilities.high", op: "==", value: 0 }],
      }),
      req("SLO", "slos", {
        type: "evidence",
        name: "slos",
        maxAgeDays: 7,
        assertions: [{ path: "data.availability", op: ">=", value: 0.999 }],
      }),
      req("LOCK", "contracts", { type: "lockfile-integrity", packageJson: "package.json", lockfile: "package-lock.json" }),
      req("RB", "rollback", { type: "file-contains", file: "runbook.md", patterns: ["^##\\s.*Rollback"] }),
    ],
  };
}

function exception(overrides: Partial<ReleaseException> = {}): ReleaseException {
  return {
    id: "EXC-1",
    requirement: "SLO",
    reason: "Status provider outage hid three days of probes",
    compensatingControl: "Manual synthetic checks every 15 minutes",
    ticket: "OPS-123",
    requestedBy: "@release-mgmt",
    approvedBy: "@sre-lead",
    createdAt: "2026-11-21T00:00:00.000Z",
    expiresAt: "2026-11-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("release readiness scorecard — decisions", () => {
  it("promotes when every blocking requirement passes", () => {
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(baseFiles()), now: NOW });
    expect(card.summary.blockingFailures).toEqual([]);
    expect(card.decision).toBe("PROMOTE");
    for (const domain of RELEASE_DOMAINS) expect(card.domains[domain]).toBe("pass");
  });

  it("blocks promotion when a blocking requirement fails", () => {
    const files = baseFiles();
    files["ev/slos.json"] = evidence("slos", { availability: 0.98 });
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(files), now: NOW });
    expect(card.decision).toBe("BLOCK");
    expect(card.summary.blockingFailures).toEqual(["SLO"]);
    expect(card.requirements.find((r) => r.id === "SLO")?.findings.join()).toMatch(/availability >= 0.999/);
  });

  it("blocks on missing, stale, mislabelled or future-dated evidence", () => {
    const cases: Array<[string | undefined, RegExp]> = [
      [undefined, /has not been collected/],
      [evidence("slos", { availability: 1 }, "2026-11-01T00:00:00.000Z"), /stale/],
      [evidence("other", { availability: 1 }), /labelled 'other'/],
      [evidence("slos", { availability: 1 }, "2026-12-01T00:00:00.000Z"), /future/],
      ["{not json", /not valid JSON/],
    ];
    for (const [content, pattern] of cases) {
      const files = baseFiles();
      if (content === undefined) delete files["ev/slos.json"];
      else files["ev/slos.json"] = content;
      const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(files), now: NOW });
      expect(card.decision).toBe("BLOCK");
      expect(card.requirements.find((r) => r.id === "SLO")?.findings.join(" ")).toMatch(pattern);
    }
  });

  it("non-blocking failures warn but do not block", () => {
    const policy = basePolicy();
    policy.requirements.find((r) => r.id === "SLO")!.blocking = false;
    const files = baseFiles();
    delete files["ev/slos.json"];
    const card = evaluateScorecard({ policy, exceptions: [], fs: memoryFs(files), now: NOW });
    expect(card.decision).toBe("PROMOTE");
    expect(card.summary.warnings).toContain("SLO failed (non-blocking)");
  });

  it("an invalid policy (a domain with no requirement) never promotes", () => {
    const policy = basePolicy();
    policy.requirements = policy.requirements.filter((r) => r.domain !== "rollback");
    const card = evaluateScorecard({ policy, exceptions: [], fs: memoryFs(baseFiles()), now: NOW });
    expect(card.decision).toBe("BLOCK");
    expect(card.domains.rollback).toBe("fail");
    expect(validatePolicy(policy)).toContain("Domain 'rollback' has no requirements.");
  });

  it("a crashing check fails closed", () => {
    const fsCrash: ReleaseFs = {
      read: () => {
        throw new Error("disk on fire");
      },
      list: () => [],
    };
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: fsCrash, now: NOW });
    expect(card.decision).toBe("BLOCK");
    expect(card.requirements[0].findings[0]).toMatch(/Check crashed: disk on fire/);
  });
});

describe("release readiness scorecard — accountable exceptions", () => {
  const failingSlo = () => {
    const files = baseFiles();
    files["ev/slos.json"] = evidence("slos", { availability: 0.98 });
    return memoryFs(files);
  };

  it("a valid exception overrides a failed overridable requirement and is recorded", () => {
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [exception()], fs: failingSlo(), now: NOW });
    expect(card.decision).toBe("PROMOTE");
    const slo = card.requirements.find((r) => r.id === "SLO")!;
    expect(slo.status).toBe("overridden");
    expect(slo.exceptionId).toBe("EXC-1");
    expect(slo.findings.length).toBeGreaterThan(0); // the failure is still visible
    expect(card.domains.slos).toBe("overridden");
    expect(card.appliedExceptions.map((e) => e.id)).toEqual(["EXC-1"]);
  });

  it("an exception for a passing requirement is not applied", () => {
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [exception()], fs: memoryFs(baseFiles()), now: NOW });
    expect(card.appliedExceptions).toEqual([]);
    expect(card.requirements.find((r) => r.id === "SLO")!.status).toBe("pass");
  });

  it.each<[string, Partial<ReleaseException>, RegExp]>([
    ["self-approval", { approvedBy: "@release-mgmt" }, /own exception/],
    ["unlisted approver", { approvedBy: "@someone" }, /not an accountable approver/],
    ["expired", { expiresAt: "2026-11-22T11:00:00.000Z" }, /expired/],
    ["too long", { createdAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-01T00:00:00.000Z" }, /14-day maximum/],
    ["missing ticket", { ticket: "" }, /missing ticket/],
    ["missing compensating control", { compensatingControl: " " }, /missing compensatingControl/],
    ["unknown requirement", { requirement: "NOPE" }, /unknown requirement/],
    ["future createdAt", { createdAt: "2026-11-23T00:00:00.000Z" }, /future/],
  ])("rejects an exception with %s and keeps promotion blocked", (_label, overrides, pattern) => {
    const card = evaluateScorecard({
      policy: basePolicy(),
      exceptions: [exception(overrides)],
      fs: failingSlo(),
      now: NOW,
    });
    expect(card.decision).toBe("BLOCK");
    expect(card.appliedExceptions).toEqual([]);
    expect(card.rejectedExceptions[0].problems.join("; ")).toMatch(pattern);
    expect(card.summary.warnings.join("\n")).toMatch(/exception EXC-1 rejected/);
  });

  it("non-overridable requirements cannot be waived, even by a listed approver", () => {
    const files = baseFiles();
    files["schema.sql"] = "CREATE TABLE public.trips (id uuid);\n";
    const problems = validateException(
      exception({ requirement: "RLS", approvedBy: "@security-lead" }),
      basePolicy(),
      NOW,
    );
    expect(problems).toContain("requirement 'RLS' cannot be overridden");

    const card = evaluateScorecard({
      policy: basePolicy(),
      exceptions: [exception({ requirement: "RLS", approvedBy: "@security-lead" })],
      fs: memoryFs(files),
      now: NOW,
    });
    expect(card.decision).toBe("BLOCK");
    expect(card.summary.blockingFailures).toEqual(["RLS"]);
  });

  it("rejects duplicate exception ids", () => {
    const card = evaluateScorecard({
      policy: basePolicy(),
      exceptions: [exception(), exception()],
      fs: failingSlo(),
      now: NOW,
    });
    expect(card.rejectedExceptions.map((e) => e.problems)).toEqual([["duplicate exception id"]]);
  });
});

describe("release readiness scorecard — checks", () => {
  it("detects a modified, untracked or missing migration", () => {
    const tampered = baseFiles();
    tampered["migrations/0001_a.sql"] = "DROP TABLE x;";
    tampered["migrations/0002_b.sql"] = MIGRATION_SQL;
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(tampered), now: NOW });
    const findings = card.requirements.find((r) => r.id === "MIG")!.findings.join("\n");
    expect(findings).toMatch(/Checksum mismatch for '0001_a.sql'/);
    expect(findings).toMatch(/Untracked migration on disk: '0002_b.sql'/);
  });

  it("requires rollback notes only for migrations after the baseline sequence", () => {
    const files = baseFiles();
    const bare = "SELECT 2;\n";
    files["migrations/0002_b.sql"] = bare;
    files["migrations/manifest.json"] = JSON.stringify({
      migrations: [
        { sequence: 1, id: "0001_a", filename: "0001_a.sql", sha256: sha256(MIGRATION_SQL) },
        { sequence: 2, id: "0002_b", filename: "0002_b.sql", sha256: sha256(bare) },
      ],
    });
    const policy = basePolicy();
    policy.requirements.push(
      req("MIG-RB", "migrations", { type: "migration-rollback-notes", dir: "migrations", manifest: "migrations/manifest.json", fromSequence: 2 }),
    );
    const card = evaluateScorecard({ policy, exceptions: [], fs: memoryFs(files), now: NOW });
    expect(card.requirements.find((r) => r.id === "MIG-RB")!.findings).toEqual([
      `Migration '0002_b.sql' has no "-- Rollback:" notes.`,
    ]);
  });

  it("finds tables without RLS, ignoring partitions, comments and exemptions", () => {
    const sql = [
      "CREATE TABLE IF NOT EXISTS public.trips (id uuid);",
      "ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;",
      "CREATE TABLE public.leaky (id uuid);",
      "CREATE TABLE IF NOT EXISTS public.logs_2026 PARTITION OF public.logs FOR VALUES FROM ('a') TO ('b');",
      "-- CREATE TABLE public.commented (id uuid);",
      "CREATE TABLE public.schema_migrations (version text);",
    ].join("\n");
    expect(findTablesWithoutRls(sql, ["schema_migrations"])).toEqual(["leaky"]);
  });

  it("flags sequential scans in captured plans and plan-less fixtures", () => {
    const files = baseFiles();
    files["plan.json"] = JSON.stringify({
      fixtures: [{ name: "slow", plan: { outer: "Seq Scan on expenses" } }, { name: "empty" }],
    });
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(files), now: NOW });
    const findings = card.requirements.find((r) => r.id === "PERF")!.findings.join("\n");
    expect(findings).toMatch(/'slow' plan uses a sequential scan/);
    expect(findings).toMatch(/'empty' has no captured plan/);
  });

  it("flags unfixed audit findings", () => {
    const files = baseFiles();
    files["audit.md"] += "| **SEC-F02** | x | P1 | y | **OPEN** |\n";
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(files), now: NOW });
    expect(card.requirements.find((r) => r.id === "SEC")!.findings).toHaveLength(1);
  });

  it("flags unlocked, integrity-less and unbounded dependencies", () => {
    const files = baseFiles();
    files["package.json"] = JSON.stringify({ dependencies: { a: "^1.0.0", b: "*", c: "latest" } });
    files["package-lock.json"] = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/a": { version: "1.0.0" }, "node_modules/b": { integrity: "x" } },
    });
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(files), now: NOW });
    const findings = card.requirements.find((r) => r.id === "LOCK")!.findings.join("\n");
    expect(findings).toMatch(/a is locked without an integrity hash/);
    expect(findings).toMatch(/dependencies.b uses an unbounded range/);
    expect(findings).toMatch(/c is declared in dependencies but not locked/);
  });

  it("evaluates assertion operators strictly", () => {
    const env = { data: { n: 5, s: "x", t: "2026-11-22T00:00:00.000Z" } };
    expect(evaluateAssertion(env, { path: "data.n", op: "<=", value: 5 }, NOW)).toBeNull();
    expect(evaluateAssertion(env, { path: "data.n", op: "<", value: 5 }, NOW)).not.toBeNull();
    expect(evaluateAssertion(env, { path: "data.n", op: "==", value: "5" }, NOW)).not.toBeNull();
    expect(evaluateAssertion(env, { path: "data.s", op: ">=", value: 1 }, NOW)).toMatch(/not numeric/);
    expect(evaluateAssertion(env, { path: "data.missing", op: "==", value: 0 }, NOW)).toMatch(/missing/);
    expect(evaluateAssertion(env, { path: "data.s", op: "exists" }, NOW)).toBeNull();
    expect(evaluateAssertion(env, { path: "data.t", op: "maxAgeHours", value: 24 }, NOW)).toBeNull();
    expect(evaluateAssertion(env, { path: "data.t", op: "maxAgeHours", value: 6 }, NOW)).toMatch(/12.0 hours old/);
  });
});

describe("release readiness scorecard — audit trail", () => {
  const ctx = {
    commit: "abc",
    actor: "ci",
    runId: "1/1",
    target: "PUBLIC",
    enforced: true,
    policySha256: "p",
    exceptionsSha256: "e",
  };

  it("records evidence digests and overrides in a hash-chained log", () => {
    const files = baseFiles();
    files["ev/slos.json"] = evidence("slos", { availability: 0.98 });
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [exception()], fs: memoryFs(files), now: NOW });

    const first = buildAuditRecord(card, ctx, null);
    const second = buildAuditRecord(card, { ...ctx, commit: "def" }, first.hash);
    const log = `${JSON.stringify(first)}\n${JSON.stringify(second)}\n`;

    expect(first.overrides).toEqual([
      expect.objectContaining({ id: "EXC-1", requirement: "SLO", approvedBy: "@sre-lead", requestedBy: "@release-mgmt" }),
    ]);
    const slo = first.requirements.find((r) => r.id === "SLO")!;
    expect(slo.status).toBe("overridden");
    expect(slo.evidence).toEqual([{ path: "ev/slos.json", sha256: sha256(files["ev/slos.json"]) }]);
    expect(verifyAuditLog(log)).toEqual({ valid: true, records: 2, errors: [] });
    expect(lastAuditHash(log)).toBe(second.hash);
  });

  it("detects edited and deleted audit records", () => {
    const card = evaluateScorecard({ policy: basePolicy(), exceptions: [], fs: memoryFs(baseFiles()), now: NOW });
    const a = buildAuditRecord(card, ctx, null);
    const b = buildAuditRecord(card, ctx, a.hash);
    const c = buildAuditRecord(card, ctx, b.hash);

    const edited = [a, { ...b, decision: "BLOCK" }, c].map((r) => JSON.stringify(r)).join("\n");
    expect(verifyAuditLog(edited).errors).toEqual(["record 2: hash does not match its content"]);

    const deleted = [a, c].map((r) => JSON.stringify(r)).join("\n");
    expect(verifyAuditLog(deleted).errors[0]).toMatch(/record 2: chain broken/);
  });
});

describe("committed release readiness policy", () => {
  const policy = JSON.parse(fs.readFileSync(path.join(ROOT, "release/readiness-policy.json"), "utf8")) as ReadinessPolicy;
  const exceptions = JSON.parse(fs.readFileSync(path.join(ROOT, "release/exceptions.json"), "utf8"));

  it("is valid and covers every required domain with an owner", () => {
    expect(validatePolicy(policy)).toEqual([]);
    for (const domain of RELEASE_DOMAINS) {
      expect(policy.requirements.some((r) => r.domain === domain)).toBe(true);
      expect((policy.approvers[domain] ?? []).length).toBeGreaterThan(0);
    }
  });

  it("every committed exception is currently valid", () => {
    for (const e of exceptions.exceptions as ReleaseException[]) {
      expect({ id: e.id, problems: validateException(e, policy, new Date()) }).toEqual({ id: e.id, problems: [] });
    }
  });

  it("repository-static requirements pass against the working tree", () => {
    const repoFs: ReleaseFs = {
      read: (p) => {
        try {
          return fs.readFileSync(path.join(ROOT, p), "utf8");
        } catch {
          return null;
        }
      },
      list: (d) => fs.readdirSync(path.join(ROOT, d)),
    };
    const card = evaluateScorecard({ policy, exceptions: [], fs: repoFs, now: new Date() });
    const staticFailures = card.requirements
      .filter((r) => policy.requirements.find((p) => p.id === r.id)!.check.type !== "evidence")
      .filter((r) => r.status !== "pass")
      .map((r) => ({ id: r.id, findings: r.findings }));
    expect(staticFailures).toEqual([]);
  });
});
