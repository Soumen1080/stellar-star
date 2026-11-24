/**
 * lib/help/search.ts
 *
 * Search over help articles (Issue #377). Pure and isomorphic, so the index is
 * built at build time and searched in the browser.
 */

export interface HelpSearchEntry {
  slug: string;
  title: string;
  summary: string;
  category: string;
  tags: string[];
  headings: string[];
  /** Lowercased article text. */
  text: string;
}

export interface HelpSearchResult {
  slug: string;
  title: string;
  summary: string;
  category: string;
  score: number;
}

export function tokenize(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((token) => token.length >= 2),
    ),
  ];
}

const WEIGHTS = { title: 8, tags: 5, headings: 3, summary: 3, text: 1 } as const;

/**
 * Every query word must appear somewhere in an article. Matches in the title
 * count most, then tags, headings and summary, then body text.
 */
export function searchHelp(index: HelpSearchEntry[], query: string, limit = 20): HelpSearchResult[] {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const results: HelpSearchResult[] = [];
  for (const entry of index) {
    const fields = {
      title: entry.title.toLowerCase(),
      tags: entry.tags.join(" ").toLowerCase(),
      headings: entry.headings.join(" ").toLowerCase(),
      summary: entry.summary.toLowerCase(),
      text: entry.text,
    };
    let score = 0;
    let matchedAll = true;
    for (const token of tokens) {
      let tokenScore = 0;
      for (const [field, weight] of Object.entries(WEIGHTS) as [keyof typeof WEIGHTS, number][]) {
        if (fields[field].includes(token)) tokenScore += weight;
      }
      if (tokenScore === 0) {
        matchedAll = false;
        break;
      }
      score += tokenScore;
    }
    if (matchedAll) {
      results.push({ slug: entry.slug, title: entry.title, summary: entry.summary, category: entry.category, score });
    }
  }

  return results
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title))
    .slice(0, limit);
}
