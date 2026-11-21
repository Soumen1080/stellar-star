/**
 * lib/help/markdown.ts
 *
 * A deliberately small Markdown subset for help articles (Issue #377).
 * Parsing produces a plain data tree; rendering (render.tsx) turns it into
 * React elements, so article text is never injected as HTML.
 *
 * Supported:
 *   ## Heading / ### Heading   (with stable ids for anchors)
 *   paragraphs                 (consecutive lines)
 *   - item / 1. item           (one level; indented lines continue an item)
 *   > callout                  (a highlighted note)
 *   **bold**, `code`, [text](href)
 *
 * Anything else is shown as plain text.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "strong"; children: Inline[] }
  | { type: "code"; value: string }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "heading"; level: 2 | 3; id: string; text: string }
  | { type: "paragraph"; children: Inline[] }
  | { type: "list"; ordered: boolean; items: Inline[][] }
  | { type: "callout"; children: Inline[] };

/** Anchor id for a heading. Must match scripts/check-help-content.js. */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[`*_]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

export function parseInline(source: string, allowLinks = true): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flush = () => {
    if (text) out.push({ type: "text", value: text });
    text = "";
  };

  let i = 0;
  while (i < source.length) {
    const rest = source.slice(i);

    if (rest.startsWith("`")) {
      const end = source.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push({ type: "code", value: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (rest.startsWith("**")) {
      const end = source.indexOf("**", i + 2);
      if (end > i + 2) {
        flush();
        out.push({ type: "strong", children: parseInline(source.slice(i + 2, end), allowLinks) });
        i = end + 2;
        continue;
      }
    }

    if (allowLinks && rest.startsWith("[")) {
      const match = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest);
      if (match) {
        flush();
        out.push({ type: "link", href: match[2], children: parseInline(match[1], false) });
        i += match[0].length;
        continue;
      }
    }

    text += source[i];
    i += 1;
  }
  flush();
  return out;
}

const UNORDERED = /^[-*]\s+(.*)$/;
const ORDERED = /^\d+\.\s+(.*)$/;

export function parseMarkdown(source: string): Block[] {
  const lines = source.replace(/\r\n/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      i += 1;
      continue;
    }

    const heading = /^(#{2,3})\s+(.+)$/.exec(trimmed);
    if (heading) {
      const text = heading[2].trim();
      blocks.push({ type: "heading", level: heading[1].length as 2 | 3, id: slugifyHeading(text), text });
      i += 1;
      continue;
    }

    if (trimmed.startsWith(">")) {
      const parts: string[] = [];
      while (i < lines.length && lines[i].trim().startsWith(">")) {
        parts.push(lines[i].trim().replace(/^>\s?/, ""));
        i += 1;
      }
      blocks.push({ type: "callout", children: parseInline(parts.join(" ").trim()) });
      continue;
    }

    const listStart = UNORDERED.exec(trimmed) ?? ORDERED.exec(trimmed);
    if (listStart) {
      const ordered = !UNORDERED.test(trimmed);
      const items: string[] = [];
      while (i < lines.length) {
        const current = lines[i];
        const t = current.trim();
        const item = ordered ? ORDERED.exec(t) : UNORDERED.exec(t);
        if (item) {
          items.push(item[1]);
        } else if (t && /^\s{2,}/.test(current) && items.length) {
          items[items.length - 1] += ` ${t}`;
        } else {
          break;
        }
        i += 1;
      }
      blocks.push({ type: "list", ordered, items: items.map((item) => parseInline(item)) });
      continue;
    }

    const parts: string[] = [];
    while (i < lines.length) {
      const t = lines[i].trim();
      if (!t || /^#{2,3}\s/.test(t) || t.startsWith(">") || UNORDERED.test(t) || ORDERED.test(t)) break;
      parts.push(t);
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(parts.join(" ")) });
  }

  return blocks;
}

export function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) => (node.type === "text" || node.type === "code" ? node.value : inlineText(node.children)))
    .join("");
}

export function blocksText(blocks: Block[]): string {
  return blocks
    .map((block) => {
      if (block.type === "heading") return block.text;
      if (block.type === "list") return block.items.map(inlineText).join(" ");
      return inlineText(block.children);
    })
    .join("\n");
}

/** Every link target in a block tree. */
export function collectLinks(blocks: Block[]): string[] {
  const out: string[] = [];
  const walk = (nodes: Inline[]) => {
    for (const node of nodes) {
      if (node.type === "link") out.push(node.href);
      if (node.type === "strong" || node.type === "link") walk(node.children);
    }
  };
  for (const block of blocks) {
    if (block.type === "list") block.items.forEach(walk);
    else if (block.type !== "heading") walk(block.children);
  }
  return out;
}

/**
 * Only these link targets are rendered as links: web URLs, mail links, and
 * in-app paths or anchors. Anything else (javascript:, data:, …) is text.
 */
export function safeHref(href: string): string | null {
  if (/^https?:\/\//i.test(href)) return href;
  if (/^mailto:[^\s]+$/i.test(href)) return href;
  if (href.startsWith("/") && !href.startsWith("//")) return href;
  if (href.startsWith("#")) return href;
  return null;
}
