"use client";

import React, { useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { Search } from "lucide-react";
import { searchHelp, type HelpSearchEntry } from "@/lib/help/search";

interface HelpGroup {
  category: string;
  articles: { slug: string; title: string; summary: string }[];
}

interface HelpSearchProps {
  index: HelpSearchEntry[];
  groups: HelpGroup[];
}

function categoryId(category: string): string {
  return `help-cat-${category.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

function ArticleLink({ slug, title, summary }: { slug: string; title: string; summary: string }) {
  return (
    <li>
      <Link
        href={`/help/${slug}`}
        className="block rounded-xl border border-[#E5E5E5] bg-white p-4 transition hover:border-[#2DD4BF] hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#0F766E]"
      >
        <span className="font-semibold text-[#0F0F14]">{title}</span>
        <span className="mt-1 block text-sm leading-6 text-[#555]">{summary}</span>
      </Link>
    </li>
  );
}

/**
 * Article search (Issue #377). The full article list is server-rendered, so
 * the page works without JavaScript; typing filters it in place and keeps the
 * query in the URL (?q=) so a search can be shared.
 */
export function HelpSearch({ index, groups }: HelpSearchProps) {
  const inputId = useId();
  const [query, setQuery] = useState("");

  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get("q");
    if (initial) setQuery(initial);
  }, []);

  useEffect(() => {
    const url = new URL(window.location.href);
    if (query.trim()) url.searchParams.set("q", query.trim());
    else url.searchParams.delete("q");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }, [query]);

  const results = useMemo(() => searchHelp(index, query), [index, query]);
  const searching = query.trim().length > 0;

  return (
    <div>
      <form role="search" action="/help" method="get" onSubmit={(e) => e.preventDefault()} className="relative">
        <label htmlFor={inputId} className="sr-only">
          Search help articles
        </label>
        <Search size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-[#777]" aria-hidden="true" />
        <input
          id={inputId}
          name="q"
          type="search"
          autoComplete="off"
          placeholder="Search, for example “trustline” or “invite expired”"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full rounded-2xl border border-[#D4D4D8] bg-white py-3.5 pl-11 pr-4 text-base text-[#0F0F14] shadow-sm focus:border-[#0F766E] focus:outline-none focus:ring-2 focus:ring-[#2DD4BF]/40"
        />
      </form>

      <p className="sr-only" aria-live="polite">
        {searching ? `${results.length} ${results.length === 1 ? "article" : "articles"} found` : ""}
      </p>

      {searching ? (
        <section className="mt-8" aria-label="Search results">
          {results.length > 0 ? (
            <ul className="space-y-3">
              {results.map((result) => (
                <ArticleLink key={result.slug} {...result} />
              ))}
            </ul>
          ) : (
            <div className="rounded-xl border border-dashed border-[#D4D4D8] bg-white p-6 text-[#555]">
              <p className="font-semibold text-[#0F0F14]">No articles match “{query.trim()}”.</p>
              <p className="mt-1 text-sm">
                Try fewer or different words, browse the topics below, or check{" "}
                <Link href="/status" className="font-semibold text-[#0F766E] underline underline-offset-2">
                  system status
                </Link>{" "}
                if something isn’t working.
              </p>
              <button
                type="button"
                onClick={() => setQuery("")}
                className="mt-3 text-sm font-semibold text-[#0F766E] underline underline-offset-2"
              >
                Clear search
              </button>
            </div>
          )}
        </section>
      ) : null}

      <div className={searching ? "mt-12" : "mt-8"}>
        {searching ? <h2 className="mb-4 text-lg font-semibold text-[#0F0F14]">All topics</h2> : null}
        <div className="space-y-10">
          {groups.map((group) => (
            <section key={group.category} aria-labelledby={categoryId(group.category)}>
              <h2
                id={categoryId(group.category)}
                className="mb-3 text-sm font-semibold uppercase tracking-wide text-[#555]"
              >
                {group.category}
              </h2>
              <ul className="grid gap-3 sm:grid-cols-2">
                {group.articles.map((article) => (
                  <ArticleLink key={article.slug} {...article} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
