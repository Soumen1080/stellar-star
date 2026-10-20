/**
 * Tag normalization.
 *
 * Tags are free-form, so they are normalized to one canonical spelling before
 * they are stored or compared: "#Beach Day", "beach-day" and " BEACH_DAY " are
 * the same tag. Without this, filtering by a tag silently misses expenses that
 * spelled it differently.
 *
 * The database re-applies the same rules in `normalize_expense_tags()`
 * (migrations/0008_expense_categories_tags_search.sql), so a client that skips
 * this module still cannot store an unnormalized tag.
 */

export const MAX_TAGS_PER_EXPENSE = 10;
export const MAX_TAG_LENGTH = 32;

// Built with the constructor so the Unicode property escapes do not depend on
// the compile target of whichever toolchain (Next, ts-jest) parses this file.
const NON_WORD_RUN = new RegExp("[^\\p{L}\\p{N}]+", "gu");

/**
 * Canonical form of one tag, or "" when nothing usable remains.
 *
 * Lowercased, a leading `#` dropped, and every run of characters that is not a
 * letter or digit collapsed to a single hyphen, trimmed from both ends.
 */
export function normalizeTag(raw: string): string {
  const collapsed = raw
    .trim()
    .toLowerCase()
    .replace(/^#+/, "")
    .replace(NON_WORD_RUN, "-")
    .replace(/^-+|-+$/g, "");
  return Array.from(collapsed).slice(0, MAX_TAG_LENGTH).join("").replace(/-+$/g, "");
}

/** Normalizes, drops empties, and de-duplicates while keeping first-seen order. */
export function normalizeTags(raw: readonly string[] | null | undefined): string[] {
  const seen = new Set<string>();
  for (const value of raw ?? []) {
    if (typeof value !== "string") continue;
    const tag = normalizeTag(value);
    if (tag) seen.add(tag);
  }
  return [...seen];
}

/** Splits the comma-separated text a user types into normalized tags. */
export function parseTagInput(input: string): string[] {
  return normalizeTags(input.split(","));
}

/** A user-facing validation message, or null when the tags are acceptable. */
export function validateTags(tags: readonly string[]): string | null {
  if (tags.length > MAX_TAGS_PER_EXPENSE) {
    return `Use at most ${MAX_TAGS_PER_EXPENSE} tags.`;
  }
  return null;
}
