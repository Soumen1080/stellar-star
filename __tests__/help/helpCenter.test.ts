/**
 * __tests__/help/helpCenter.test.ts
 *
 * Issue #377: a searchable, versioned help center whose content has an owner
 * and review date, with links checked in CI.
 */

import fs from "fs";
import os from "os";
import path from "path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  collectLinks,
  parseInline,
  parseMarkdown,
  safeHref,
  slugifyHeading,
} from "@/lib/help/markdown";
import { HelpArticleBody } from "@/lib/help/render";
import { searchHelp, tokenize } from "@/lib/help/search";
import {
  buildHelpSearchIndex,
  getHelpArticles,
  groupHelpArticles,
  parseHelpArticle,
} from "@/lib/help/articles";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const checker = require("../../scripts/check-help-content.js");

describe("help articles", () => {
  const articles = getHelpArticles();

  it("covers every topic the help center promises", () => {
    const slugs = articles.map((a) => a.slug);
    for (const topic of ["wallet-setup", "invitations", "payments", "transaction-lookup", "corrections", "privacy", "safety"]) {
      expect(slugs).toContain(topic);
    }
  });

  it("versions every article and names its owner and review date", () => {
    for (const article of articles) {
      expect({ slug: article.slug, version: /^\d+\.\d+\.\d+$/.test(article.version) }).toEqual({ slug: article.slug, version: true });
      expect(article.owner.trim().length).toBeGreaterThan(0);
      expect(article.updated).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(article.tags.length).toBeGreaterThan(0);
      expect(article.blocks.length).toBeGreaterThan(3);
    }
  });

  it("refuses an article without front matter", () => {
    expect(() => parseHelpArticle("broken", "# no front matter\n\ntext")).toThrow(/missing front matter/);
  });

  it("groups articles in the documented category order", () => {
    const groups = groupHelpArticles(articles).map((g) => g.category);
    expect(groups[0]).toBe("Getting started");
    expect(new Set(groups).size).toBe(groups.length);
  });
});

describe("search", () => {
  const index = buildHelpSearchIndex(getHelpArticles());
  const top = (q: string) => searchHelp(index, q)[0]?.slug;

  it.each([
    ["trustline", "wallet-setup"],
    ["invite expired", "invitations"],
    ["seed phrase", "safety"],
    ["recovery phrase", "safety"],
    ["transaction hash", "transaction-lookup"],
    ["off-chain only", "payments"],
    ["void reason", "corrections"],
    ["export data", "privacy"],
    ["outage", "service-status"],
  ])("finds %p in %p first", (query, slug) => {
    expect(top(query)).toBe(slug);
  });

  it("requires every word to match", () => {
    expect(searchHelp(index, "trustline zebra")).toEqual([]);
  });

  it("ignores punctuation, case and one-letter words", () => {
    expect(tokenize("  A Wallet!!  wallet ")).toEqual(["wallet"]);
    expect(searchHelp(index, "")).toEqual([]);
    expect(searchHelp(index, "?")).toEqual([]);
  });
});

describe("markdown subset", () => {
  it("parses headings with stable anchors, lists, callouts and paragraphs", () => {
    const blocks = parseMarkdown(
      [
        "## Fund your account",
        "",
        "A paragraph that",
        "spans two lines.",
        "",
        "- one",
        "- two",
        "  continued",
        "",
        "1. first",
        "2. second",
        "",
        "> careful",
        "> now",
      ].join("\n"),
    );
    expect(blocks.map((b) => b.type)).toEqual(["heading", "paragraph", "list", "list", "callout"]);
    expect(blocks[0]).toEqual({ type: "heading", level: 2, id: "fund-your-account", text: "Fund your account" });
    expect(blocks[2]).toEqual(expect.objectContaining({ ordered: false }));
    expect((blocks[2] as any).items).toHaveLength(2);
    expect((blocks[3] as any).ordered).toBe(true);
  });

  it("parses bold, code and links, including bold link text", () => {
    expect(parseInline("**Bold [x](/a)** `c` [y](https://e.com)")).toEqual([
      { type: "strong", children: [{ type: "text", value: "Bold " }, { type: "link", href: "/a", children: [{ type: "text", value: "x" }] }] },
      { type: "text", value: " " },
      { type: "code", value: "c" },
      { type: "text", value: " " },
      { type: "link", href: "https://e.com", children: [{ type: "text", value: "y" }] },
    ]);
  });

  it("only links safe targets", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,x")).toBeNull();
    expect(safeHref("//evil.example")).toBeNull();
    expect(safeHref("/help/safety")).toBe("/help/safety");
    expect(safeHref("#top")).toBe("#top");
    expect(safeHref("https://stellar.expert")).toBe("https://stellar.expert");
    expect(safeHref("mailto:privacy@stellarstar.app")).toBe("mailto:privacy@stellarstar.app");
  });

  it("renders text, never raw HTML, and neutralises unsafe links", () => {
    const html = renderToStaticMarkup(
      React.createElement(HelpArticleBody, {
        blocks: parseMarkdown('Hi <img src=x onerror=alert(1)> [bad](javascript:alert(1)) [ok](https://example.com)'),
      }),
    );
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://example.com"');
    expect(html).toContain('rel="noopener noreferrer"');
  });

  it("uses the same anchor rules as the CI link checker", () => {
    const samples = ["Fund your account", "Don't pay twice!", "**Bold** heading", "Look up `hash` (v2)", "A  -  B"];
    for (const article of getHelpArticles()) samples.push(...article.headings.map((h) => h.text));
    for (const sample of samples) expect(checker.slugify(sample)).toBe(slugifyHeading(sample));
  });

  it("finds the same links as the CI link checker", () => {
    for (const article of getHelpArticles()) {
      const source = fs.readFileSync(path.join(process.cwd(), "content", "help", `${article.slug}.md`), "utf8");
      const { body } = checker.parseFrontmatter(source);
      expect(checker.collectLinks(body).sort()).toEqual(collectLinks(article.blocks).sort());
    }
  });
});

describe("content checker (npm run help:check)", () => {
  it("passes on the repository's content", async () => {
    const { errors, checkedLinks } = await checker.checkHelpContent({ offline: true });
    expect(errors).toEqual([]);
    expect(checkedLinks).toBeGreaterThan(10);
  });

  function fixture(files: Record<string, string>): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "help-check-"));
    for (const [file, content] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    }
    return root;
  }

  const meta = (overrides: Record<string, string> = {}) =>
    [
      "---",
      ...Object.entries({
        title: "T",
        summary: "S",
        category: "Payments",
        version: "1.0.0",
        updated: "2026-11-01",
        owner: "Support team",
        reviewBy: "2027-04-01",
        tags: "a, b",
        ...overrides,
      }).map(([k, v]) => `${k}: ${v}`),
      "---",
      "",
    ].join("\n");
  const statusJson = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({ version: "1.0.0", updated: "2026-11-01", owner: "Platform on-call", reviewBy: "2027-04-01", ...extra });
  const doc = "# Doc\n\nOwner: Platform on-call\nReview by: 2027-04-01\nVersion: 1.0.0\n";
  const NOW = Date.parse("2026-11-21T12:00:00Z");

  function baseFiles(extra: Record<string, string> = {}) {
    return {
      "app/page.tsx": "",
      "app/status/page.tsx": "",
      "content/status/components.json": statusJson({ components: [] }),
      "content/status/incidents.json": statusJson({ incidents: [] }),
      "docs/INCIDENT_COMMUNICATION.md": doc,
      ...extra,
    };
  }

  it("reports broken routes, help slugs, anchors and relative files", async () => {
    const root = fixture(
      baseFiles({
        "content/help/one.md":
          meta() +
          "## Real heading\n\n[a](/status) [b](/nowhere) [c](/help/missing) [d](#nope) [e](#real-heading) [f](/help/one#ghost) [g](javascript:x)\n",
      }),
    );
    const { errors } = await checker.checkHelpContent({ root, now: NOW, offline: true });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("no app page for /nowhere"),
        expect.stringContaining("no help article for /help/missing"),
        expect.stringContaining("no heading for anchor #nope"),
        expect.stringContaining("/help/one has no heading for #ghost"),
        expect.stringContaining("unsupported link scheme"),
      ]),
    );
    expect(errors.join("\n")).not.toContain("/status");
    expect(errors.join("\n")).not.toContain("#real-heading");
  });

  it("fails an overdue review, a missing owner and a malformed version", async () => {
    const root = fixture(
      baseFiles({
        "content/help/stale.md": meta({ reviewBy: "2026-11-01", updated: "2026-05-01" }) + "Body\n",
        "content/help/ownerless.md": meta({ owner: "", version: "v1" }) + "Body\n",
      }),
    );
    const { errors } = await checker.checkHelpContent({ root, now: NOW, offline: true });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("content/help/stale.md: review was due 2026-11-01"),
        expect.stringContaining("content/help/ownerless.md: missing front matter: owner"),
        expect.stringContaining("version must be semver"),
      ]),
    );
  });

  it("fails status content and the incident doc without owner or current review", async () => {
    const root = fixture({
      ...baseFiles(),
      "content/help/ok.md": meta() + "Body\n",
      "content/status/components.json": JSON.stringify({ version: "1.0.0", updated: "2026-11-01", reviewBy: "2026-11-02", components: [] }),
      "docs/INCIDENT_COMMUNICATION.md": "# Doc\n\nReview by: 2026-01-01\n",
    });
    const { errors } = await checker.checkHelpContent({ root, now: NOW, offline: true });
    expect(errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("content/status/components.json: owner is required"),
        expect.stringContaining("content/status/components.json: review was due"),
        expect.stringContaining('docs/INCIDENT_COMMUNICATION.md: add an "Owner:" line'),
        expect.stringContaining("docs/INCIDENT_COMMUNICATION.md: review was due 2026-01-01"),
        expect.stringContaining('add a "Version: x.y.z" line'),
      ]),
    );
  });

  it("fails an open incident whose update is overdue for its severity", async () => {
    const incident = {
      id: "slow-recording",
      severity: "sev1",
      startedAt: "2026-11-21T10:00:00Z",
      updates: [{ at: "2026-11-21T11:00:00Z", status: "investigating", message: "x" }],
    };
    const root = fixture(
      baseFiles({
        "content/help/ok.md": meta() + "Body\n",
        "content/status/incidents.json": statusJson({ incidents: [incident] }),
      }),
    );
    const { errors } = await checker.checkHelpContent({ root, now: NOW, offline: true });
    expect(errors).toEqual([expect.stringContaining('incident "slow-recording": update overdue')]);
  });
});
