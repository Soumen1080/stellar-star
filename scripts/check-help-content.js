#!/usr/bin/env node
/**
 * scripts/check-help-content.js
 *
 * CI check for help and status content (Issue #377). Run: npm run help:check
 *
 * Fails when:
 *   - a help article (content/help/*.md) is missing front matter, or has a
 *     malformed version or dates;
 *   - any help article, the status content (content/status/*.json) or
 *     docs/INCIDENT_COMMUNICATION.md lacks an owner, or its review date has
 *     passed or is more than a year after its last update;
 *   - an unresolved incident has gone longer than its severity's update
 *     cadence without a public update;
 *   - a link is broken: an in-app path with no page, a /help/<slug> with no
 *     article, an #anchor with no heading, a relative file that doesn't exist,
 *     or a remote URL that returns 404/410 or can't be reached.
 *
 * Set HELP_LINKS_OFFLINE=1 or pass --offline to skip remote URLs.
 */

const fs = require("fs");
const path = require("path");

const DAY_MS = 86_400_000;
const MAX_REVIEW_INTERVAL_DAYS = 366;
/** Mirrors INCIDENT_POLICY in lib/status/incidents.ts (asserted by tests). */
const UPDATE_CADENCE_MINUTES = { sev1: 30, sev2: 60, sev3: 240 };
const FRONTMATTER_FIELDS = ["title", "summary", "category", "version", "updated", "owner", "reviewBy", "tags"];
const SEMVER = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Must match slugifyHeading in lib/help/markdown.ts. */
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function parseFrontmatter(source) {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  const data = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: normalized.slice(match[0].length) };
}

function headingIds(markdown) {
  const ids = new Set();
  for (const line of markdown.split("\n")) {
    const m = /^\s*#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) ids.add(slugify(m[1]));
  }
  return ids;
}

function collectLinks(markdown) {
  const links = [];
  // Ignore fenced code blocks: they hold templates, not links.
  const withoutCode = markdown.replace(/```[\s\S]*?```/g, "");
  const re = /\[[^\]]+\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(withoutCode)) !== null) links.push(m[1]);
  return links;
}

function parseDate(value) {
  if (typeof value !== "string" || !DATE.test(value)) return NaN;
  return Date.parse(`${value}T00:00:00Z`);
}

function checkOwnership(label, { owner, updated, reviewBy, version }, now, errors) {
  if (!owner || !String(owner).trim()) errors.push(`${label}: owner is required`);
  if (version !== undefined && !SEMVER.test(String(version))) errors.push(`${label}: version must be semver (x.y.z)`);
  const updatedAt = parseDate(updated);
  const reviewAt = parseDate(reviewBy);
  if (Number.isNaN(updatedAt)) errors.push(`${label}: updated must be YYYY-MM-DD`);
  if (Number.isNaN(reviewAt)) {
    errors.push(`${label}: reviewBy must be YYYY-MM-DD`);
    return;
  }
  const today = Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z");
  if (reviewAt < today) errors.push(`${label}: review was due ${reviewBy}; review the content and move reviewBy forward`);
  if (!Number.isNaN(updatedAt)) {
    if (reviewAt < updatedAt) errors.push(`${label}: reviewBy is before updated`);
    if (reviewAt - updatedAt > MAX_REVIEW_INTERVAL_DAYS * DAY_MS) {
      errors.push(`${label}: reviewBy must be within ${MAX_REVIEW_INTERVAL_DAYS} days of updated`);
    }
  }
}

function appRouteExists(root, pathname) {
  const clean = pathname.replace(/\/+$/, "") || "/";
  const dir = clean === "/" ? path.join(root, "app") : path.join(root, "app", ...clean.split("/").filter(Boolean));
  return ["page.tsx", "page.ts", "page.jsx", "page.js"].some((file) => fs.existsSync(path.join(dir, file)));
}

async function checkRemote(url) {
  const attempt = async (method) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12_000);
    try {
      const res = await fetch(url, { method, redirect: "follow", signal: controller.signal });
      return res.status;
    } finally {
      clearTimeout(timer);
    }
  };
  for (let tries = 0; tries < 2; tries += 1) {
    try {
      let status = await attempt("HEAD");
      if (status === 405 || status === 501) status = await attempt("GET");
      // 404/410 mean the page is gone. Other statuses (403/429 from bot
      // protection, 5xx blips) don't prove the link is wrong.
      return status !== 404 && status !== 410;
    } catch {
      // retry once, then report unreachable
    }
  }
  return false;
}

/**
 * @param {{ root?: string, now?: number, offline?: boolean }} options
 * @returns {Promise<{ errors: string[], checkedLinks: number }>}
 */
async function checkHelpContent({ root = path.resolve(__dirname, ".."), now = Date.now(), offline = false } = {}) {
  const errors = [];
  const helpDir = path.join(root, "content", "help");
  const files = fs.existsSync(helpDir) ? fs.readdirSync(helpDir).filter((f) => f.endsWith(".md")).sort() : [];
  if (files.length === 0) errors.push("content/help has no articles");

  const articles = new Map();
  for (const file of files) {
    const slug = file.replace(/\.md$/, "");
    const source = fs.readFileSync(path.join(helpDir, file), "utf8");
    const { data, body } = parseFrontmatter(source);
    articles.set(slug, { data, body, file: `content/help/${file}`, ids: headingIds(body) });
  }

  for (const [slug, { data, file }] of articles) {
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) errors.push(`${file}: file name must be a lowercase-hyphenated slug`);
    const missing = FRONTMATTER_FIELDS.filter((field) => !data[field]);
    if (missing.length) errors.push(`${file}: missing front matter: ${missing.join(", ")}`);
    if (data.summary && data.summary.length > 200) errors.push(`${file}: summary must be at most 200 characters`);
    checkOwnership(file, data, now, errors);
  }

  // Status content
  const statusFiles = ["components.json", "incidents.json"];
  const statusData = {};
  for (const name of statusFiles) {
    const file = path.join(root, "content", "status", name);
    if (!fs.existsSync(file)) {
      errors.push(`content/status/${name} is missing`);
      continue;
    }
    try {
      statusData[name] = JSON.parse(fs.readFileSync(file, "utf8"));
      checkOwnership(`content/status/${name}`, statusData[name], now, errors);
    } catch (err) {
      errors.push(`content/status/${name}: invalid JSON (${err.message})`);
    }
  }
  for (const incident of statusData["incidents.json"]?.incidents ?? []) {
    if (incident.resolvedAt) continue;
    const cadence = UPDATE_CADENCE_MINUTES[incident.severity];
    const last = incident.updates?.[incident.updates.length - 1];
    const lastAt = Date.parse(last?.at ?? incident.startedAt);
    if (cadence && !Number.isNaN(lastAt) && now - lastAt > cadence * 60_000) {
      errors.push(`incident "${incident.id}": update overdue (${incident.severity} requires one every ${cadence} minutes)`);
    }
  }

  // Incident communication doc
  const docs = [{ file: "docs/INCIDENT_COMMUNICATION.md" }];
  for (const doc of docs) {
    const full = path.join(root, doc.file);
    if (!fs.existsSync(full)) {
      errors.push(`${doc.file} is missing`);
      continue;
    }
    const text = fs.readFileSync(full, "utf8");
    doc.text = text;
    doc.ids = headingIds(text);
    const owner = /^Owner:\s*(.+)$/m.exec(text)?.[1];
    const reviewBy = /^Review by:\s*(\S+)$/m.exec(text)?.[1];
    const version = /^Version:\s*(\S+)$/m.exec(text)?.[1];
    if (!owner) errors.push(`${doc.file}: add an "Owner:" line`);
    if (!reviewBy || Number.isNaN(parseDate(reviewBy))) errors.push(`${doc.file}: add a "Review by: YYYY-MM-DD" line`);
    else if (parseDate(reviewBy) < Date.parse(new Date(now).toISOString().slice(0, 10) + "T00:00:00Z")) {
      errors.push(`${doc.file}: review was due ${reviewBy}`);
    }
    if (!version || !SEMVER.test(version)) errors.push(`${doc.file}: add a "Version: x.y.z" line`);
  }

  // Links
  const sources = [
    ...[...articles.values()].map((a) => ({ file: a.file, dir: helpDir, text: a.body, ids: a.ids })),
    ...docs.filter((d) => d.text).map((d) => ({ file: d.file, dir: path.dirname(path.join(root, d.file)), text: d.text, ids: d.ids })),
  ];
  const remote = new Map();
  let checkedLinks = 0;

  for (const source of sources) {
    for (const link of collectLinks(source.text)) {
      checkedLinks += 1;
      if (/^mailto:[^\s@]+@[^\s@]+$/i.test(link)) continue;
      if (/^https?:\/\//i.test(link)) {
        if (!remote.has(link)) remote.set(link, []);
        remote.get(link).push(source.file);
        continue;
      }
      if (link.startsWith("#")) {
        if (!source.ids.has(link.slice(1))) errors.push(`${source.file}: no heading for anchor ${link}`);
        continue;
      }
      if (link.startsWith("/")) {
        const [pathname, anchor] = link.split("#");
        const help = /^\/help\/([^/]+)\/?$/.exec(pathname);
        if (help) {
          const target = articles.get(help[1]);
          if (!target) errors.push(`${source.file}: no help article for ${link}`);
          else if (anchor && !target.ids.has(anchor)) errors.push(`${source.file}: ${pathname} has no heading for #${anchor}`);
          continue;
        }
        if (!appRouteExists(root, pathname)) errors.push(`${source.file}: no app page for ${link}`);
        continue;
      }
      if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
        errors.push(`${source.file}: unsupported link scheme in ${link}`);
        continue;
      }
      const [relative] = link.split("#");
      if (!fs.existsSync(path.resolve(source.dir, relative))) errors.push(`${source.file}: broken relative link ${link}`);
    }
  }

  if (!offline) {
    await Promise.all(
      [...remote.entries()].map(async ([url, where]) => {
        if (!(await checkRemote(url))) errors.push(`${where.join(", ")}: remote link unreachable or gone: ${url}`);
      }),
    );
  }

  return { errors, checkedLinks };
}

module.exports = { checkHelpContent, slugify, parseFrontmatter, collectLinks, UPDATE_CADENCE_MINUTES };

if (require.main === module) {
  const offline = process.argv.includes("--offline") || process.env.HELP_LINKS_OFFLINE === "1";
  checkHelpContent({ offline })
    .then(({ errors, checkedLinks }) => {
      if (errors.length) {
        console.error("Help and status content check failed:");
        for (const error of errors) console.error(`- ${error}`);
        process.exit(1);
      }
      console.log(`Help and status content check passed (${checkedLinks} links${offline ? ", remote skipped" : ""}).`);
    })
    .catch((err) => {
      console.error("Help content checker crashed:", err);
      process.exit(1);
    });
}
