/**
 * lib/help/render.tsx
 *
 * Renders parsed help Markdown (lib/help/markdown.ts) as React elements.
 */

import React from "react";
import Link from "next/link";
import { safeHref, type Block, type Inline } from "./markdown";

const LINK_CLASS = "font-semibold text-[#0F766E] underline underline-offset-2 hover:text-[#115E59]";

function renderInline(nodes: Inline[], keyPrefix: string): React.ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return <React.Fragment key={key}>{node.value}</React.Fragment>;
      case "code":
        return (
          <code key={key} className="rounded bg-black/5 px-1 py-0.5 font-mono text-[0.9em]">
            {node.value}
          </code>
        );
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "link": {
        const href = safeHref(node.href);
        const children = renderInline(node.children, key);
        if (!href) return <React.Fragment key={key}>{children}</React.Fragment>;
        if (href.startsWith("/") || href.startsWith("#")) {
          return (
            <Link key={key} href={href} className={LINK_CLASS}>
              {children}
            </Link>
          );
        }
        const external = /^https?:/i.test(href);
        return (
          <a
            key={key}
            href={href}
            className={LINK_CLASS}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {children}
            {external ? <span className="sr-only"> (opens in a new tab)</span> : null}
          </a>
        );
      }
    }
  });
}

export function HelpArticleBody({ blocks }: { blocks: Block[] }) {
  return (
    <div className="space-y-4 leading-7 text-[#1F1F24]">
      {blocks.map((block, index) => {
        const key = `b-${index}`;
        switch (block.type) {
          case "heading":
            return block.level === 2 ? (
              <h2 key={key} id={block.id} className="scroll-mt-24 pt-4 text-xl font-semibold text-[#0F0F14]">
                {block.text}
              </h2>
            ) : (
              <h3 key={key} id={block.id} className="scroll-mt-24 pt-2 text-lg font-semibold text-[#0F0F14]">
                {block.text}
              </h3>
            );
          case "paragraph":
            return <p key={key}>{renderInline(block.children, key)}</p>;
          case "callout":
            return (
              <aside
                key={key}
                className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-3 text-[#134E4A]"
              >
                {renderInline(block.children, key)}
              </aside>
            );
          case "list": {
            const items = block.items.map((item, itemIndex) => (
              <li key={`${key}-${itemIndex}`}>{renderInline(item, `${key}-${itemIndex}`)}</li>
            ));
            return block.ordered ? (
              <ol key={key} className="list-decimal space-y-1.5 pl-6">
                {items}
              </ol>
            ) : (
              <ul key={key} className="list-disc space-y-1.5 pl-6">
                {items}
              </ul>
            );
          }
        }
      })}
    </div>
  );
}
