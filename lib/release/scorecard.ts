/**
 * lib/release/scorecard.ts
 *
 * Release readiness scorecard (#447).
 *
 * The repository already has several independent safety controls (the mainnet
 * Go/No-Go doc, config validation, the wallet-bypass build gate, migration
 * manifest checks, recovery drills). None of them produces one verifiable
 * promotion decision. This module does:
 *
 *   policy (release/readiness-policy.json)
 *     + machine-readable checks over the repository
 *     + evidence envelopes (release/evidence/*.json)
 *     + accountable exceptions (release/exceptions.json)
 *   → one scorecard with a PROMOTE / BLOCK decision
 *   → one hash-chained audit record of the decision, its evidence digests and
 *     every override that was applied (or rejected).
 *
 * Invariants:
 *   1. A failed blocking requirement blocks promotion unless a *valid*
 *      exception covers it. Invalid exceptions never apply and are reported.
 *   2. An exception is valid only when it names an accountable requester and a
 *      different, policy-listed approver, has a ticket, a reason, a
 *      compensating control, is not expired, does not exceed the policy's
 *      maximum duration, and targets an overridable requirement.
 *   3. Every file a check reads is digested (SHA-256) into the audit record, so
 *      the evidence behind a decision cannot be swapped after the fact.
 *   4. Audit records are hash-chained; editing or deleting a past record breaks
 *      verification of every later one.
 *
 * The module is pure apart from hashing: all file access goes through the
 * `ReleaseFs` abstraction so tests run against in-memory fixtures.
 */

import { createHash } from "node:crypto";

// ─── Types ───────────────────────────────────────────────────────────────────

export const RELEASE_DOMAINS = [
  "migrations",
  "rls",
  "performance",
  "security",
  "backups",
  "dependencies",
  "slos",
  "contracts",
  "rollback",
] as const;

export type ReleaseDomain = (typeof RELEASE_DOMAINS)[number];

export type AssertionOp =
  | "=="
  | "!="
  | "<="
  | ">="
  | "<"
  | ">"
  | "exists"
  | "maxAgeHours";

export interface EvidenceAssertion {
  /** Dotted path into the evidence envelope, e.g. "data.metadata.vulnerabilities.high". */
  path: string;
  op: AssertionOp;
  value?: string | number | boolean;
}

export type CheckSpec =
  | { type: "migration-manifest"; dir: string; manifest: string }
  | { type: "migration-rollback-notes"; dir: string; manifest: string; fromSequence: number }
  | { type: "rls-enabled"; schemaFile: string; exempt?: string[] }
  | { type: "query-plan-fixtures"; files: string[] }
  | { type: "file-contains"; file: string; patterns: string[] }
  | { type: "line-rules"; file: string; lineMatches: string; mustMatch: string }
  | { type: "lockfile-integrity"; packageJson: string; lockfile: string }
  | { type: "evidence"; name: string; maxAgeDays: number; assertions: EvidenceAssertion[] };

export interface Requirement {
  id: string;
  domain: ReleaseDomain;
  title: string;
  /** The accountable owner of this requirement (role or named person). */
  owner: string;
  /** A failed blocking requirement blocks promotion. */
  blocking: boolean;
  /** Whether an accountable exception may override a failure. */
  overridable: boolean;
  check: CheckSpec;
}

export interface ReadinessPolicy {
  version: string;
  evidenceDir: string;
  /** Maximum lifetime of an exception, from createdAt to expiresAt. */
  maxExceptionDays: number;
  /** People allowed to approve exceptions, per domain. */
  approvers: Partial<Record<ReleaseDomain, string[]>>;
  requirements: Requirement[];
}

export interface ReleaseException {
  id: string;
  requirement: string;
  reason: string;
  compensatingControl: string;
  ticket: string;
  requestedBy: string;
  approvedBy: string;
  createdAt: string;
  expiresAt: string;
}

export interface EvidenceEnvelope {
  name: string;
  collectedAt: string;
  source: string;
  commit?: string;
  data: unknown;
}

export interface EvidenceDigest {
  path: string;
  sha256: string | null;
}

export type RequirementStatus = "pass" | "fail" | "overridden";

export interface RequirementResult {
  id: string;
  domain: ReleaseDomain;
  title: string;
  owner: string;
  blocking: boolean;
  status: RequirementStatus;
  findings: string[];
  evidence: EvidenceDigest[];
  exceptionId?: string;
}

export interface RejectedException {
  id: string;
  requirement: string;
  problems: string[];
}

export type PromotionDecision = "PROMOTE" | "BLOCK";

export interface Scorecard {
  schemaVersion: 1;
  policyVersion: string;
  evaluatedAt: string;
  decision: PromotionDecision;
  summary: {
    total: number;
    passed: number;
    failed: number;
    overridden: number;
    blockingFailures: string[];
    warnings: string[];
  };
  domains: Record<ReleaseDomain, RequirementStatus>;
  requirements: RequirementResult[];
  appliedExceptions: ReleaseException[];
  rejectedExceptions: RejectedException[];
}

/** Read-only file access rooted at the repository. Paths are repo-relative. */
export interface ReleaseFs {
  read(path: string): string | null;
  list(dir: string): string[];
}

// ─── Hashing helpers ─────────────────────────────────────────────────────────

export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** JSON with recursively sorted keys, so equal objects hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Wraps a ReleaseFs so every read is digested for the audit record. */
class RecordingFs {
  readonly reads = new Map<string, string | null>();
  private readonly inner: ReleaseFs;
  constructor(inner: ReleaseFs) {
    this.inner = inner;
  }

  read(path: string): string | null {
    const content = this.inner.read(path);
    this.reads.set(path, content === null ? null : sha256(normalizeEol(content)));
    return content;
  }

  list(dir: string): string[] {
    return this.inner.list(dir);
  }

  digests(): EvidenceDigest[] {
    return [...this.reads.entries()]
      .map(([path, digest]) => ({ path, sha256: digest }))
      .sort((a, b) => a.path.localeCompare(b.path));
  }
}

function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function stripSqlComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n");
}

function joinPath(dir: string, file: string): string {
  return dir.replace(/\/+$/, "") + "/" + file;
}

// ─── Checks ──────────────────────────────────────────────────────────────────

interface ManifestEntry {
  sequence: number;
  id: string;
  filename: string;
  sha256: string;
}

function readManifest(fs: RecordingFs, path: string, findings: string[]): ManifestEntry[] | null {
  const raw = fs.read(path);
  if (raw === null) {
    findings.push(`Migration manifest ${path} is missing.`);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as { migrations?: ManifestEntry[] };
    if (!Array.isArray(parsed.migrations)) {
      findings.push(`Migration manifest ${path} has no migrations array.`);
      return null;
    }
    return parsed.migrations;
  } catch {
    findings.push(`Migration manifest ${path} is not valid JSON.`);
    return null;
  }
}

function checkMigrationManifest(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "migration-manifest" }>,
): string[] {
  const findings: string[] = [];
  const entries = readManifest(fs, spec.manifest, findings);
  if (!entries) return findings;

  const onDisk = fs.list(spec.dir).filter((f) => f.endsWith(".sql")).sort();
  const tracked = new Set<string>();
  const ids = new Set<string>();

  entries.forEach((entry, index) => {
    if (entry.sequence !== index + 1) {
      findings.push(`Manifest sequence gap or reorder at '${entry.id}': expected ${index + 1}, found ${entry.sequence}.`);
    }
    if (ids.has(entry.id)) findings.push(`Duplicate migration id '${entry.id}'.`);
    ids.add(entry.id);
    if (tracked.has(entry.filename)) findings.push(`Migration file '${entry.filename}' is tracked twice.`);
    tracked.add(entry.filename);

    const content = fs.read(joinPath(spec.dir, entry.filename));
    if (content === null) {
      findings.push(`Manifest entry '${entry.id}' points at missing file '${entry.filename}'.`);
      return;
    }
    const lf = sha256(normalizeEol(content));
    const raw = sha256(content);
    if (entry.sha256 !== lf && entry.sha256 !== raw) {
      findings.push(`Checksum mismatch for '${entry.filename}': applied history was modified.`);
    }
  });

  for (const file of onDisk) {
    if (!tracked.has(file)) findings.push(`Untracked migration on disk: '${file}' is not in the manifest.`);
  }
  return findings;
}

function checkMigrationRollbackNotes(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "migration-rollback-notes" }>,
): string[] {
  const findings: string[] = [];
  const entries = readManifest(fs, spec.manifest, findings);
  if (!entries) return findings;

  for (const entry of entries) {
    if (entry.sequence < spec.fromSequence) continue;
    const content = fs.read(joinPath(spec.dir, entry.filename));
    if (content === null) continue; // reported by migration-manifest
    if (!/^\s*--\s*Rollback\b/im.test(content)) {
      findings.push(`Migration '${entry.filename}' has no "-- Rollback:" notes.`);
    }
  }
  return findings;
}

/**
 * Every table created in the canonical schema must enable RLS. Partitions
 * (`CREATE TABLE … PARTITION OF`) inherit the parent's policies when queried
 * through it and are exempt; anything else must be listed in `exempt`.
 */
export function findTablesWithoutRls(sql: string, exempt: string[] = []): string[] {
  const clean = stripSqlComments(sql);
  const created = new Set<string>();
  const re = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?(\w+)"?([^;(]*)/gi;
  for (const match of clean.matchAll(re)) {
    if (/PARTITION\s+OF/i.test(match[2])) continue;
    created.add(match[1].toLowerCase());
  }

  const enabled = new Set<string>();
  const rlsRe = /ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?(?:public\.)?"?(\w+)"?\s+ENABLE\s+ROW\s+LEVEL\s+SECURITY/gi;
  for (const match of clean.matchAll(rlsRe)) enabled.add(match[1].toLowerCase());

  const exemptSet = new Set(exempt.map((t) => t.toLowerCase()));
  return [...created].filter((t) => !enabled.has(t) && !exemptSet.has(t)).sort();
}

function checkRls(fs: RecordingFs, spec: Extract<CheckSpec, { type: "rls-enabled" }>): string[] {
  const sql = fs.read(spec.schemaFile);
  if (sql === null) return [`Schema file ${spec.schemaFile} is missing.`];
  return findTablesWithoutRls(sql, spec.exempt).map(
    (t) => `Table public.${t} does not enable row level security.`,
  );
}

function checkQueryPlanFixtures(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "query-plan-fixtures" }>,
): string[] {
  const findings: string[] = [];
  for (const file of spec.files) {
    const raw = fs.read(file);
    if (raw === null) {
      findings.push(`Query-plan fixture ${file} is missing.`);
      continue;
    }
    let parsed: { fixtures?: Array<{ name?: string; plan?: unknown; plans?: unknown }> };
    try {
      parsed = JSON.parse(raw);
    } catch {
      findings.push(`Query-plan fixture ${file} is not valid JSON.`);
      continue;
    }
    const fixtures = Array.isArray(parsed.fixtures) ? parsed.fixtures : [];
    if (fixtures.length === 0) findings.push(`Query-plan fixture ${file} records no plans.`);
    for (const fixture of fixtures) {
      const plan = fixture.plan ?? fixture.plans;
      if (plan === undefined) {
        findings.push(`${file}: fixture '${fixture.name ?? "?"}' has no captured plan.`);
        continue;
      }
      if (/Seq Scan/i.test(JSON.stringify(plan))) {
        findings.push(`${file}: fixture '${fixture.name ?? "?"}' plan uses a sequential scan.`);
      }
    }
  }
  return findings;
}

function checkFileContains(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "file-contains" }>,
): string[] {
  const content = fs.read(spec.file);
  if (content === null) return [`Required file ${spec.file} is missing.`];
  return spec.patterns
    .filter((p) => !new RegExp(p, "im").test(content))
    .map((p) => `${spec.file} does not match required pattern /${p}/.`);
}

function checkLineRules(fs: RecordingFs, spec: Extract<CheckSpec, { type: "line-rules" }>): string[] {
  const content = fs.read(spec.file);
  if (content === null) return [`Required file ${spec.file} is missing.`];
  const select = new RegExp(spec.lineMatches, "i");
  const require = new RegExp(spec.mustMatch, "i");
  const findings: string[] = [];
  normalizeEol(content)
    .split("\n")
    .forEach((line, i) => {
      if (select.test(line) && !require.test(line)) {
        findings.push(`${spec.file}:${i + 1} matches /${spec.lineMatches}/ but not /${spec.mustMatch}/.`);
      }
    });
  return findings;
}

const FLOATING_RANGE = /^(\*|latest|x|)$|^(>=?|\|\|)/i;

function checkLockfile(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "lockfile-integrity" }>,
): string[] {
  const pkgRaw = fs.read(spec.packageJson);
  const lockRaw = fs.read(spec.lockfile);
  if (pkgRaw === null) return [`${spec.packageJson} is missing.`];
  if (lockRaw === null) return [`${spec.lockfile} is missing; installs are not reproducible.`];

  let pkg: Record<string, Record<string, string> | undefined>;
  let lock: { lockfileVersion?: number; packages?: Record<string, { version?: string; integrity?: string }> };
  try {
    pkg = JSON.parse(pkgRaw);
    lock = JSON.parse(lockRaw);
  } catch {
    return ["package.json or the lockfile is not valid JSON."];
  }

  const findings: string[] = [];
  if ((lock.lockfileVersion ?? 0) < 2) findings.push(`Lockfile version ${lock.lockfileVersion ?? "?"} is below 2.`);
  const packages = lock.packages ?? {};
  for (const section of ["dependencies", "devDependencies"]) {
    for (const [name, range] of Object.entries(pkg[section] ?? {})) {
      if (FLOATING_RANGE.test(range.trim())) {
        findings.push(`${section}.${name} uses an unbounded range "${range}".`);
      }
      const locked = packages[`node_modules/${name}`];
      if (!locked) {
        findings.push(`${name} is declared in ${section} but not locked.`);
      } else if (!locked.integrity && !/^(file|link):/.test(range)) {
        findings.push(`${name} is locked without an integrity hash.`);
      }
    }
  }
  return findings;
}

function getPath(obj: unknown, dotted: string): unknown {
  let cur: unknown = obj;
  for (const key of dotted.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

export function evaluateAssertion(
  envelope: unknown,
  assertion: EvidenceAssertion,
  now: Date,
): string | null {
  const actual = getPath(envelope, assertion.path);
  const label = `${assertion.path} ${assertion.op}${assertion.value === undefined ? "" : ` ${assertion.value}`}`;

  if (assertion.op === "exists") {
    return actual === undefined || actual === null || actual === "" ? `expected ${assertion.path} to be present` : null;
  }
  if (actual === undefined || actual === null) return `expected ${label}, but ${assertion.path} is missing`;

  if (assertion.op === "maxAgeHours") {
    const at = Date.parse(String(actual));
    if (Number.isNaN(at)) return `expected ${assertion.path} to be an ISO timestamp`;
    const hours = (now.getTime() - at) / 3_600_000;
    return hours <= Number(assertion.value) && hours >= -1
      ? null
      : `expected ${label}, but it is ${hours.toFixed(1)} hours old`;
  }

  const expected = assertion.value;
  let ok: boolean;
  switch (assertion.op) {
    case "==":
      ok = actual === expected;
      break;
    case "!=":
      ok = actual !== expected;
      break;
    default: {
      const a = Number(actual);
      const b = Number(expected);
      if (!Number.isFinite(a) || !Number.isFinite(b)) return `expected ${label}, but values are not numeric`;
      ok =
        assertion.op === "<=" ? a <= b : assertion.op === ">=" ? a >= b : assertion.op === "<" ? a < b : a > b;
    }
  }
  return ok ? null : `expected ${label}, found ${JSON.stringify(actual)}`;
}

function checkEvidence(
  fs: RecordingFs,
  spec: Extract<CheckSpec, { type: "evidence" }>,
  evidenceDir: string,
  now: Date,
): string[] {
  const file = joinPath(evidenceDir, `${spec.name}.json`);
  const raw = fs.read(file);
  if (raw === null) return [`Evidence ${file} has not been collected.`];

  let envelope: EvidenceEnvelope;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return [`Evidence ${file} is not valid JSON.`];
  }

  const findings: string[] = [];
  if (envelope.name !== spec.name) findings.push(`Evidence ${file} is labelled '${envelope.name}', expected '${spec.name}'.`);
  if (!envelope.source) findings.push(`Evidence ${file} does not record its source.`);
  const collectedAt = Date.parse(envelope.collectedAt);
  if (Number.isNaN(collectedAt)) {
    findings.push(`Evidence ${file} has no valid collectedAt timestamp.`);
  } else {
    const ageDays = (now.getTime() - collectedAt) / 86_400_000;
    if (ageDays > spec.maxAgeDays) {
      findings.push(`Evidence ${file} is stale: ${ageDays.toFixed(1)} days old (max ${spec.maxAgeDays}).`);
    } else if (ageDays < -1 / 24) {
      findings.push(`Evidence ${file} is dated in the future.`);
    }
  }

  for (const assertion of spec.assertions) {
    const problem = evaluateAssertion(envelope, assertion, now);
    if (problem) findings.push(`Evidence '${spec.name}': ${problem}.`);
  }
  return findings;
}

function runCheck(fs: RecordingFs, spec: CheckSpec, policy: ReadinessPolicy, now: Date): string[] {
  switch (spec.type) {
    case "migration-manifest":
      return checkMigrationManifest(fs, spec);
    case "migration-rollback-notes":
      return checkMigrationRollbackNotes(fs, spec);
    case "rls-enabled":
      return checkRls(fs, spec);
    case "query-plan-fixtures":
      return checkQueryPlanFixtures(fs, spec);
    case "file-contains":
      return checkFileContains(fs, spec);
    case "line-rules":
      return checkLineRules(fs, spec);
    case "lockfile-integrity":
      return checkLockfile(fs, spec);
    case "evidence":
      return checkEvidence(fs, spec, policy.evidenceDir, now);
    default:
      return [`Unknown check type '${(spec as { type: string }).type}'.`];
  }
}

// ─── Policy & exception validation ───────────────────────────────────────────

export function validatePolicy(policy: ReadinessPolicy): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const req of policy.requirements ?? []) {
    if (ids.has(req.id)) problems.push(`Duplicate requirement id '${req.id}'.`);
    ids.add(req.id);
    if (!RELEASE_DOMAINS.includes(req.domain)) problems.push(`Requirement '${req.id}' has unknown domain '${req.domain}'.`);
    if (!req.owner || /^(tbd|-|none)$/i.test(req.owner.trim())) problems.push(`Requirement '${req.id}' has no accountable owner.`);
  }
  for (const domain of RELEASE_DOMAINS) {
    if (!(policy.requirements ?? []).some((r) => r.domain === domain)) {
      problems.push(`Domain '${domain}' has no requirements.`);
    }
  }
  if (!(policy.maxExceptionDays > 0)) problems.push("maxExceptionDays must be positive.");
  return problems;
}

const REQUIRED_EXCEPTION_FIELDS: Array<keyof ReleaseException> = [
  "id",
  "requirement",
  "reason",
  "compensatingControl",
  "ticket",
  "requestedBy",
  "approvedBy",
  "createdAt",
  "expiresAt",
];

export function validateException(
  exception: ReleaseException,
  policy: ReadinessPolicy,
  now: Date,
): string[] {
  const problems: string[] = [];
  for (const field of REQUIRED_EXCEPTION_FIELDS) {
    const value = exception[field];
    if (typeof value !== "string" || value.trim() === "") problems.push(`missing ${field}`);
  }
  if (problems.length > 0) return problems;

  const requirement = policy.requirements.find((r) => r.id === exception.requirement);
  if (!requirement) return [`unknown requirement '${exception.requirement}'`];
  if (!requirement.overridable) problems.push(`requirement '${requirement.id}' cannot be overridden`);

  const requester = exception.requestedBy.trim().toLowerCase();
  const approver = exception.approvedBy.trim().toLowerCase();
  if (requester === approver) problems.push("requester cannot approve their own exception");

  const allowed = (policy.approvers[requirement.domain] ?? []).map((a) => a.toLowerCase());
  if (!allowed.includes(approver)) {
    problems.push(`'${exception.approvedBy}' is not an accountable approver for ${requirement.domain}`);
  }

  const created = Date.parse(exception.createdAt);
  const expires = Date.parse(exception.expiresAt);
  if (Number.isNaN(created) || Number.isNaN(expires)) {
    problems.push("createdAt/expiresAt must be ISO timestamps");
  } else {
    if (expires <= now.getTime()) problems.push(`expired at ${exception.expiresAt}`);
    if (created > now.getTime()) problems.push("createdAt is in the future");
    if (expires <= created) problems.push("expiresAt must be after createdAt");
    if ((expires - created) / 86_400_000 > policy.maxExceptionDays) {
      problems.push(`lifetime exceeds the ${policy.maxExceptionDays}-day maximum`);
    }
  }
  return problems;
}

// ─── Evaluation ──────────────────────────────────────────────────────────────

export interface EvaluateInput {
  policy: ReadinessPolicy;
  exceptions: ReleaseException[];
  fs: ReleaseFs;
  now: Date;
}

export function evaluateScorecard({ policy, exceptions, fs, now }: EvaluateInput): Scorecard {
  const policyProblems = validatePolicy(policy);

  const validExceptions = new Map<string, ReleaseException>();
  const rejectedExceptions: RejectedException[] = [];
  const seenIds = new Set<string>();
  for (const exception of exceptions) {
    const problems = validateException(exception, policy, now);
    if (exception.id && seenIds.has(exception.id)) problems.push("duplicate exception id");
    seenIds.add(exception.id);
    if (problems.length > 0) {
      rejectedExceptions.push({ id: exception.id ?? "?", requirement: exception.requirement ?? "?", problems });
    } else if (!validExceptions.has(exception.requirement)) {
      validExceptions.set(exception.requirement, exception);
    }
  }

  const appliedExceptions: ReleaseException[] = [];
  const requirements: RequirementResult[] = policy.requirements.map((req) => {
    const recording = new RecordingFs(fs);
    let findings: string[];
    try {
      findings = runCheck(recording, req.check, policy, now);
    } catch (err) {
      findings = [`Check crashed: ${err instanceof Error ? err.message : String(err)}`];
    }

    let status: RequirementStatus = findings.length === 0 ? "pass" : "fail";
    let exceptionId: string | undefined;
    const exception = validExceptions.get(req.id);
    if (status === "fail" && exception) {
      status = "overridden";
      exceptionId = exception.id;
      appliedExceptions.push(exception);
    }

    return {
      id: req.id,
      domain: req.domain,
      title: req.title,
      owner: req.owner,
      blocking: req.blocking,
      status,
      findings,
      evidence: recording.digests(),
      ...(exceptionId ? { exceptionId } : {}),
    };
  });

  const blockingFailures = requirements.filter((r) => r.blocking && r.status === "fail").map((r) => r.id);
  const warnings = [
    ...policyProblems.map((p) => `policy: ${p}`),
    ...requirements.filter((r) => !r.blocking && r.status === "fail").map((r) => `${r.id} failed (non-blocking)`),
    ...rejectedExceptions.map((e) => `exception ${e.id} rejected: ${e.problems.join("; ")}`),
  ];

  const domains = {} as Record<ReleaseDomain, RequirementStatus>;
  for (const domain of RELEASE_DOMAINS) {
    const inDomain = requirements.filter((r) => r.domain === domain);
    domains[domain] =
      inDomain.length === 0 || inDomain.some((r) => r.status === "fail")
        ? "fail"
        : inDomain.some((r) => r.status === "overridden")
          ? "overridden"
          : "pass";
  }

  // An invalid policy can never promote: a missing domain is a missing control.
  const decision: PromotionDecision =
    blockingFailures.length === 0 && policyProblems.length === 0 ? "PROMOTE" : "BLOCK";

  return {
    schemaVersion: 1,
    policyVersion: policy.version,
    evaluatedAt: now.toISOString(),
    decision,
    summary: {
      total: requirements.length,
      passed: requirements.filter((r) => r.status === "pass").length,
      failed: requirements.filter((r) => r.status === "fail").length,
      overridden: requirements.filter((r) => r.status === "overridden").length,
      blockingFailures,
      warnings,
    },
    domains,
    requirements,
    appliedExceptions,
    rejectedExceptions,
  };
}

// ─── Audit trail ─────────────────────────────────────────────────────────────

export interface AuditContext {
  commit: string;
  actor: string;
  runId: string;
  target: string;
  enforced: boolean;
  policySha256: string;
  exceptionsSha256: string;
}

export interface AuditRecord {
  schemaVersion: 1;
  recordedAt: string;
  decision: PromotionDecision;
  enforced: boolean;
  commit: string;
  actor: string;
  runId: string;
  target: string;
  policyVersion: string;
  policySha256: string;
  exceptionsSha256: string;
  scorecardSha256: string;
  requirements: Array<{
    id: string;
    status: RequirementStatus;
    exceptionId?: string;
    evidence: EvidenceDigest[];
  }>;
  overrides: Array<Pick<ReleaseException, "id" | "requirement" | "requestedBy" | "approvedBy" | "ticket" | "expiresAt">>;
  rejectedExceptions: RejectedException[];
  prevHash: string | null;
  hash: string;
}

export function buildAuditRecord(
  scorecard: Scorecard,
  context: AuditContext,
  prevHash: string | null,
): AuditRecord {
  const body: Omit<AuditRecord, "hash"> = {
    schemaVersion: 1,
    recordedAt: scorecard.evaluatedAt,
    decision: scorecard.decision,
    enforced: context.enforced,
    commit: context.commit,
    actor: context.actor,
    runId: context.runId,
    target: context.target,
    policyVersion: scorecard.policyVersion,
    policySha256: context.policySha256,
    exceptionsSha256: context.exceptionsSha256,
    scorecardSha256: sha256(canonicalJson(scorecard)),
    requirements: scorecard.requirements.map((r) => ({
      id: r.id,
      status: r.status,
      ...(r.exceptionId ? { exceptionId: r.exceptionId } : {}),
      evidence: r.evidence,
    })),
    overrides: scorecard.appliedExceptions.map((e) => ({
      id: e.id,
      requirement: e.requirement,
      requestedBy: e.requestedBy,
      approvedBy: e.approvedBy,
      ticket: e.ticket,
      expiresAt: e.expiresAt,
    })),
    rejectedExceptions: scorecard.rejectedExceptions,
    prevHash,
  };
  return { ...body, hash: sha256(canonicalJson(body)) };
}

/** Verifies a JSONL audit log: every record's hash and its link to the previous one. */
export function verifyAuditLog(jsonl: string): { valid: boolean; records: number; errors: string[] } {
  const errors: string[] = [];
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim() !== "");
  let prev: string | null = null;
  lines.forEach((line, i) => {
    let record: AuditRecord;
    try {
      record = JSON.parse(line);
    } catch {
      errors.push(`record ${i + 1}: not valid JSON`);
      prev = null;
      return;
    }
    const { hash, ...body } = record;
    if (sha256(canonicalJson(body)) !== hash) errors.push(`record ${i + 1}: hash does not match its content`);
    if (record.prevHash !== prev) errors.push(`record ${i + 1}: chain broken (prevHash does not match record ${i})`);
    prev = hash;
  });
  return { valid: errors.length === 0, records: lines.length, errors };
}

export function lastAuditHash(jsonl: string): string | null {
  const lines = jsonl.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  try {
    return (JSON.parse(lines[lines.length - 1]) as AuditRecord).hash ?? null;
  } catch {
    return null;
  }
}

export function makeEvidenceEnvelope(
  name: string,
  source: string,
  data: unknown,
  now: Date,
  commit?: string,
): EvidenceEnvelope {
  return { name, collectedAt: now.toISOString(), source, ...(commit ? { commit } : {}), data };
}

/** Human-readable scorecard for CI logs. */
export function formatScorecard(scorecard: Scorecard): string {
  const icon: Record<RequirementStatus, string> = { pass: "PASS", fail: "FAIL", overridden: "OVRD" };
  const lines = [
    "=====================================================",
    "        Stellar-star Release Readiness Scorecard     ",
    "=====================================================",
    `Policy version : ${scorecard.policyVersion}`,
    `Evaluated at   : ${scorecard.evaluatedAt}`,
    `Requirements   : ${scorecard.summary.passed} pass, ${scorecard.summary.failed} fail, ${scorecard.summary.overridden} overridden`,
    "-----------------------------------------------------",
  ];
  for (const domain of RELEASE_DOMAINS) {
    lines.push(`[${icon[scorecard.domains[domain]]}] ${domain}`);
    for (const r of scorecard.requirements.filter((x) => x.domain === domain)) {
      const tag = r.blocking ? "" : " (non-blocking)";
      lines.push(`    ${icon[r.status]} ${r.id}${tag} — ${r.title} [owner: ${r.owner}]`);
      if (r.exceptionId) lines.push(`         overridden by exception ${r.exceptionId}`);
      for (const f of r.findings) lines.push(`         - ${f}`);
    }
  }
  if (scorecard.summary.warnings.length > 0) {
    lines.push("-----------------------------------------------------", "Warnings:");
    for (const w of scorecard.summary.warnings) lines.push(`  ! ${w}`);
  }
  lines.push(
    "-----------------------------------------------------",
    `DECISION: ${scorecard.decision}` +
      (scorecard.decision === "BLOCK" ? ` (blocking: ${scorecard.summary.blockingFailures.join(", ") || "invalid policy"})` : ""),
  );
  return lines.join("\n");
}
