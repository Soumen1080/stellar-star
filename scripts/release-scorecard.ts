/**
 * scripts/release-scorecard.ts
 *
 * CLI for the release readiness scorecard (#447). Run with tsx:
 *
 *   npx tsx scripts/release-scorecard.ts evaluate [--report-only] [--target PUBLIC]
 *       [--out release/out/scorecard.json] [--audit-log release/out/promotion-audit.jsonl]
 *     Evaluates release/readiness-policy.json, prints the scorecard, writes it as
 *     JSON, and appends a hash-chained audit record of the decision. Exits 1 when
 *     the decision is BLOCK, unless --report-only is given (used on pull requests,
 *     where promotion is not being requested).
 *
 *   npx tsx scripts/release-scorecard.ts collect --name <name> --source "<what produced it>"
 *       (--from <raw.json> | --data '<json>')
 *     Wraps raw tool output (npm audit --json, drill results, load-test summaries)
 *     in an evidence envelope with collectedAt and the commit it describes.
 *
 *   npx tsx scripts/release-scorecard.ts verify-audit [--audit-log <path>]
 *     Verifies the audit log's hash chain. Exits 1 if any record was altered.
 */

import fs from "node:fs";
import path from "node:path";
import {
  buildAuditRecord,
  evaluateScorecard,
  formatScorecard,
  lastAuditHash,
  makeEvidenceEnvelope,
  sha256,
  verifyAuditLog,
  type ReadinessPolicy,
  type ReleaseException,
  type ReleaseFs,
} from "../lib/release/scorecard";

const ROOT = path.resolve(__dirname, "..");
const POLICY_PATH = "release/readiness-policy.json";
const EXCEPTIONS_PATH = "release/exceptions.json";
const DEFAULT_OUT = "release/out/scorecard.json";
const DEFAULT_AUDIT_LOG = "release/out/promotion-audit.jsonl";

function arg(args: string[], name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function repoFs(root: string): ReleaseFs {
  const resolve = (p: string) => {
    const abs = path.resolve(root, p);
    // Checks are declared in a committed policy, but never let one escape the repo.
    if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error(`Path escapes repository: ${p}`);
    return abs;
  };
  return {
    read(p) {
      try {
        return fs.readFileSync(resolve(p), "utf8");
      } catch {
        return null;
      }
    },
    list(dir) {
      try {
        return fs.readdirSync(resolve(dir));
      } catch {
        return [];
      }
    },
  };
}

function gitCommit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    const head = fs.readFileSync(path.join(ROOT, ".git", "HEAD"), "utf8").trim();
    if (!head.startsWith("ref:")) return head;
    const ref = head.slice(5).trim();
    return fs.readFileSync(path.join(ROOT, ".git", ref), "utf8").trim();
  } catch {
    return "unknown";
  }
}

function writeFile(rel: string, content: string, append = false): void {
  const abs = path.resolve(ROOT, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (append) fs.appendFileSync(abs, content);
  else fs.writeFileSync(abs, content);
}

function evaluate(args: string[]): number {
  const rfs = repoFs(ROOT);
  const policyRaw = rfs.read(POLICY_PATH);
  if (policyRaw === null) {
    console.error(`FATAL: ${POLICY_PATH} is missing.`);
    return 1;
  }
  const exceptionsRaw = rfs.read(EXCEPTIONS_PATH) ?? '{"exceptions":[]}';
  const policy = JSON.parse(policyRaw) as ReadinessPolicy;
  const exceptions = (JSON.parse(exceptionsRaw) as { exceptions?: ReleaseException[] }).exceptions ?? [];

  const reportOnly = args.includes("--report-only");
  const target = arg(args, "target") ?? "PUBLIC";
  const out = arg(args, "out") ?? DEFAULT_OUT;
  const auditLog = arg(args, "audit-log") ?? DEFAULT_AUDIT_LOG;

  const scorecard = evaluateScorecard({ policy, exceptions, fs: rfs, now: new Date() });
  console.log(formatScorecard(scorecard));

  const existingLog = rfs.read(auditLog) ?? "";
  const chain = verifyAuditLog(existingLog);
  if (!chain.valid) {
    console.error(`Audit log ${auditLog} failed verification; refusing to extend a tampered chain:`);
    chain.errors.forEach((e) => console.error(`  ✗ ${e}`));
    return 1;
  }

  const record = buildAuditRecord(
    scorecard,
    {
      commit: gitCommit(),
      actor: process.env.GITHUB_ACTOR ?? process.env.USER ?? "unknown",
      runId: process.env.GITHUB_RUN_ID
        ? `${process.env.GITHUB_RUN_ID}/${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
        : "local",
      target,
      enforced: !reportOnly,
      policySha256: sha256(policyRaw.replace(/\r\n/g, "\n")),
      exceptionsSha256: sha256(exceptionsRaw.replace(/\r\n/g, "\n")),
    },
    lastAuditHash(existingLog),
  );

  writeFile(out, JSON.stringify(scorecard, null, 2) + "\n");
  writeFile(auditLog, JSON.stringify(record) + "\n", true);
  console.log(`Scorecard written to ${out}; audit record ${record.hash.slice(0, 16)} appended to ${auditLog}.`);

  if (scorecard.decision === "BLOCK") {
    if (reportOnly) {
      console.warn("Report-only mode: promotion was not requested, so the BLOCK decision is advisory.");
      return 0;
    }
    console.error("PROMOTION BLOCKED: resolve the failed requirements or record an accountable exception.");
    return 1;
  }
  console.log("Release readiness scorecard passed: promotion is permitted.");
  return 0;
}

function collect(args: string[]): number {
  const name = arg(args, "name");
  const source = arg(args, "source");
  const from = arg(args, "from");
  const inline = arg(args, "data");
  if (!name || !/^[a-z0-9-]+$/.test(name) || !source || (!from && !inline)) {
    console.error('Usage: collect --name <kebab-name> --source "<producer>" (--from <file> | --data <json>)');
    return 2;
  }
  let data: unknown;
  try {
    data = JSON.parse(from ? fs.readFileSync(path.resolve(process.cwd(), from), "utf8") : (inline as string));
  } catch (err) {
    console.error(`Could not read evidence data: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const envelope = makeEvidenceEnvelope(name, source, data, new Date(), gitCommit());
  const dir = arg(args, "evidence-dir") ?? "release/evidence";
  const rel = `${dir}/${name}.json`;
  writeFile(rel, JSON.stringify(envelope, null, 2) + "\n");
  console.log(`Evidence '${name}' written to ${rel}.`);
  return 0;
}

function verifyAudit(args: string[]): number {
  const auditLog = arg(args, "audit-log") ?? DEFAULT_AUDIT_LOG;
  const content = repoFs(ROOT).read(auditLog);
  if (content === null) {
    console.error(`Audit log ${auditLog} does not exist.`);
    return 1;
  }
  const result = verifyAuditLog(content);
  if (!result.valid) {
    result.errors.forEach((e) => console.error(`  ✗ ${e}`));
    return 1;
  }
  console.log(`✓ ${result.records} audit record(s) verified; hash chain intact.`);
  return 0;
}

function main(): number {
  const [command, ...args] = process.argv.slice(2);
  switch (command) {
    case "evaluate":
    case undefined:
      return evaluate(args);
    case "collect":
      return collect(args);
    case "verify-audit":
      return verifyAudit(args);
    default:
      console.error(`Unknown command '${command}'. Use evaluate, collect, or verify-audit.`);
      return 2;
  }
}

process.exit(main());
