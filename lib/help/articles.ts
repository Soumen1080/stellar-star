/**
 * lib/help/articles.ts
 *
 * Loads versioned help articles from content/help/*.md (Issue #377). Server
 * only, and used at build time: every help page is statically generated.
 *
 * Each article starts with front matter:
 *   title, summary, category, version (semver), updated (YYYY-MM-DD),
 *   owner, reviewBy (YYYY-MM-DD), tags (comma separated)
 *
 * scripts/check-help-content.js enforces the same fields in CI, along with
 * review dates and links.
 */

import fs from "fs";
import path from "path";
import { blocksText, parseMarkdown, type Block } from "./markdown";
import type { HelpSearchEntry } from "./search";

export const HELP_CONTENT_DIR = path.join(process.cwd(), "content", "help");

/** Display order of categories on the help index. */
export const HELP_CATEGORIES = [
  "Getting started",
  "Trips and expenses",
  "Payments",
  "Account and privacy",
] as const;

export interface HelpArticle {
  slug: string;
  title: string;
  summary: string;
  category: string;
  version: string;
  updated: string;
  owner: string;
  reviewBy: string;
  tags: string[];
  blocks: Block[];
  headings: { id: string; text: string; level: 2 | 3 }[];
}

const REQUIRED = ["title", "summary", "category", "version", "updated", "owner", "reviewBy", "tags"] as const;

export function parseFrontmatter(source: string): { data: Record<string, string>; body: string } {
  const normalized = source.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };
  const data: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (kv) data[kv[1]] = kv[2].trim();
  }
  return { data, body: normalized.slice(match[0].length) };
}

export function parseHelpArticle(slug: string, source: string): HelpArticle {
  const { data, body } = parseFrontmatter(source);
  const missing = REQUIRED.filter((field) => !data[field]);
  if (missing.length) {
    throw new Error(`Help article "${slug}" is missing front matter: ${missing.join(", ")}`);
  }
  const blocks = parseMarkdown(body);
  return {
    slug,
    title: data.title,
    summary: data.summary,
    category: data.category,
    version: data.version,
    updated: data.updated,
    owner: data.owner,
    reviewBy: data.reviewBy,
    tags: data.tags.split(",").map((tag) => tag.trim()).filter(Boolean),
    blocks,
    headings: blocks.flatMap((block) =>
      block.type === "heading" ? [{ id: block.id, text: block.text, level: block.level }] : [],
    ),
  };
}

let cache: HelpArticle[] | null = null;

export function getHelpArticles(): HelpArticle[] {
  if (cache) return cache;
  const files = fs
    .readdirSync(HELP_CONTENT_DIR)
    .filter((file) => file.endsWith(".md"))
    .sort();
  cache = files.map((file) =>
    parseHelpArticle(file.replace(/\.md$/, ""), fs.readFileSync(path.join(HELP_CONTENT_DIR, file), "utf8")),
  );
  return cache;
}

export function getHelpArticle(slug: string): HelpArticle | null {
  return getHelpArticles().find((article) => article.slug === slug) ?? null;
}

export function buildHelpSearchIndex(articles: HelpArticle[]): HelpSearchEntry[] {
  return articles.map((article) => ({
    slug: article.slug,
    title: article.title,
    summary: article.summary,
    category: article.category,
    tags: article.tags,
    headings: article.headings.map((h) => h.text),
    text: blocksText(article.blocks).toLowerCase(),
  }));
}

export function groupHelpArticles(articles: HelpArticle[]) {
  const order = new Map<string, number>(HELP_CATEGORIES.map((c, i) => [c, i]));
  const groups = new Map<string, HelpArticle[]>();
  for (const article of articles) {
    groups.set(article.category, [...(groups.get(article.category) ?? []), article]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => (order.get(a) ?? 99) - (order.get(b) ?? 99) || a.localeCompare(b))
    .map(([category, items]) => ({
      category,
      articles: items
        .sort((a, b) => a.title.localeCompare(b.title))
        .map(({ slug, title, summary }) => ({ slug, title, summary })),
    }));
}

/** "21 Nov 2026" for a YYYY-MM-DD date. */
export function formatHelpDate(value: string): string {
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}
