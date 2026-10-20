/**
 * The expense-history filter model, shared by every layer that touches it.
 *
 * One definition is parsed from the browser URL (so a filtered view survives a
 * reload and can be shared as a link), serialized onto the `/api/expenses`
 * request, validated again by that route, and — when the server is unreachable
 * — evaluated locally against cached expenses by `matchesExpenseHistoryFilters`.
 * Keeping the semantics in one module is what stops the offline view and the
 * server view from disagreeing about what "partially paid" or "this tag" means.
 *
 * The SQL twin of `matchesExpenseHistoryFilters` is `public.search_expenses()`
 * in migrations/0008_expense_categories_tags_search.sql.
 */

import type { Expense } from "@/types/expense";
import { EXPENSE_CATEGORIES, UNCATEGORIZED } from "@/lib/expense/categories";
import { MAX_TAGS_PER_EXPENSE, normalizeTag } from "@/lib/expense/tags";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { NATIVE_ASSET_KEY, assetKey, tryParseAssetKey } from "@/lib/stellar/assets";

export const SETTLEMENT_FILTERS = ["all", "open", "unpaid", "partial", "settled"] as const;

/**
 * - `open`    — not fully settled (the original "Open" filter; unpaid + partial)
 * - `unpaid`  — no member has paid a share yet
 * - `partial` — some, but not all, shares are paid
 * - `settled` — every share is paid
 */
export type ExpenseSettlementFilter = (typeof SETTLEMENT_FILTERS)[number];

export type ExpenseSettlementState = "unpaid" | "partial" | "settled";

export interface ExpenseHistoryFilters {
  /** Free text matched against title, description, members, tags and tx hashes. */
  q: string;
  /** A category key, `"uncategorized"`, or null for any. */
  category: string | null;
  /** Normalized tags; an expense must carry all of them. */
  tags: string[];
  /** Payer member id or payer wallet address. */
  payer: string | null;
  status: ExpenseSettlementFilter;
  /** Canonical settlement asset key ("native", "USDC:G…"), or null for any. */
  asset: string | null;
  /** Inclusive local calendar dates, `YYYY-MM-DD`. */
  from: string | null;
  to: string | null;
}

export const EMPTY_HISTORY_FILTERS: Readonly<ExpenseHistoryFilters> = Object.freeze({
  q: "",
  category: null,
  tags: [],
  payer: null,
  status: "all",
  asset: null,
  from: null,
  to: null,
});

export const MAX_QUERY_LENGTH = 200;
export const MAX_SEARCH_TERMS = 8;
const MAX_PAYER_LENGTH = 64;
/** Real-world UTC offsets span -12:00 to +14:00. */
const MAX_TZ_OFFSET_MINUTES = 14 * 60;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** URL / query-string keys. Short and stable, because they end up in shared links. */
const KEYS = {
  q: "q",
  category: "category",
  tags: "tags",
  payer: "payer",
  status: "status",
  asset: "asset",
  from: "from",
  to: "to",
} as const;

export const HISTORY_FILTER_KEYS: readonly string[] = Object.values(KEYS);

export class HistoryFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HistoryFilterError";
  }
}

// ─── Field parsers ────────────────────────────────────────────────────────────

function parseDate(raw: string, field: string): string {
  const match = DATE_RE.exec(raw);
  if (match) {
    const [, y, m, d] = match.map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    if (date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d) {
      return raw;
    }
  }
  throw new HistoryFilterError(`Invalid ${field} date: use YYYY-MM-DD.`);
}

function parseCategory(raw: string): string {
  const value = raw.trim().toLowerCase();
  if (value === UNCATEGORIZED || (EXPENSE_CATEGORIES as readonly string[]).includes(value)) {
    return value;
  }
  throw new HistoryFilterError(`Unknown category "${raw}".`);
}

function parseStatus(raw: string): ExpenseSettlementFilter {
  const value = raw.trim().toLowerCase();
  if ((SETTLEMENT_FILTERS as readonly string[]).includes(value)) {
    return value as ExpenseSettlementFilter;
  }
  throw new HistoryFilterError(`Invalid status "${raw}". Use one of: ${SETTLEMENT_FILTERS.join(", ")}.`);
}

/** Normalizes an asset filter to the same canonical key `settlementAssetOf` reports. */
export function normalizeAssetFilter(raw: string): string {
  const value = raw.trim();
  if (!value || value === NATIVE_ASSET_KEY || value.toUpperCase() === "XLM") return NATIVE_ASSET_KEY;
  const parsed = tryParseAssetKey(value);
  if (!parsed) throw new HistoryFilterError(`Invalid asset "${raw}". Use "native" or CODE:ISSUER.`);
  return assetKey(parsed);
}

function parseTags(raw: string): string[] {
  const tags = [...new Set(raw.split(",").map(normalizeTag).filter(Boolean))];
  if (tags.length > MAX_TAGS_PER_EXPENSE) {
    throw new HistoryFilterError(`Filter by at most ${MAX_TAGS_PER_EXPENSE} tags.`);
  }
  return tags;
}

// ─── Parse / serialize ────────────────────────────────────────────────────────

/**
 * Reads filters from query parameters.
 *
 * `strict` (the API route) throws `HistoryFilterError` on the first invalid
 * value, so a malformed request is a 400 rather than a silently broader result.
 * Lenient mode (the browser URL) drops invalid values instead: a hand-edited or
 * stale link should still open the page, just without the bad filter.
 */
export function parseHistoryFilters(
  params: URLSearchParams,
  { strict = false }: { strict?: boolean } = {},
): ExpenseHistoryFilters {
  const filters: ExpenseHistoryFilters = { ...EMPTY_HISTORY_FILTERS, tags: [] };

  const read = <T>(key: string, parse: (raw: string) => T, apply: (value: T) => void) => {
    const raw = params.get(key);
    if (raw === null || raw.trim() === "") return;
    try {
      apply(parse(raw));
    } catch (err) {
      if (strict) throw err;
    }
  };

  read(KEYS.q, (raw) => {
    if (raw.length > MAX_QUERY_LENGTH) {
      throw new HistoryFilterError(`Search text must be at most ${MAX_QUERY_LENGTH} characters.`);
    }
    return raw;
  }, (value) => (filters.q = value));
  read(KEYS.category, parseCategory, (value) => (filters.category = value));
  read(KEYS.tags, parseTags, (value) => (filters.tags = value));
  read(KEYS.payer, (raw) => {
    const value = raw.trim();
    if (value.length > MAX_PAYER_LENGTH) throw new HistoryFilterError("Invalid payer.");
    return value;
  }, (value) => (filters.payer = value));
  read(KEYS.status, parseStatus, (value) => (filters.status = value));
  read(KEYS.asset, normalizeAssetFilter, (value) => (filters.asset = value));
  read(KEYS.from, (raw) => parseDate(raw.trim(), "from"), (value) => (filters.from = value));
  read(KEYS.to, (raw) => parseDate(raw.trim(), "to"), (value) => (filters.to = value));

  if (filters.from && filters.to && filters.from > filters.to) {
    if (strict) throw new HistoryFilterError("The from date must be on or before the to date.");
    filters.to = null;
  }

  return filters;
}

/**
 * Writes filters onto query parameters, removing keys for inactive filters so
 * URLs stay short and an unfiltered view has a clean URL. Parameters that are
 * not filter keys (pagination, a trip tab) are preserved.
 */
export function historyFiltersToParams(
  filters: ExpenseHistoryFilters,
  base?: URLSearchParams,
): URLSearchParams {
  const params = new URLSearchParams(base);
  for (const key of HISTORY_FILTER_KEYS) params.delete(key);

  if (filters.q.trim()) params.set(KEYS.q, filters.q.trim());
  if (filters.category) params.set(KEYS.category, filters.category);
  if (filters.tags.length > 0) params.set(KEYS.tags, filters.tags.join(","));
  if (filters.payer) params.set(KEYS.payer, filters.payer);
  if (filters.status !== "all") params.set(KEYS.status, filters.status);
  if (filters.asset) params.set(KEYS.asset, filters.asset);
  if (filters.from) params.set(KEYS.from, filters.from);
  if (filters.to) params.set(KEYS.to, filters.to);
  return params;
}

export function hasActiveHistoryFilters(filters: ExpenseHistoryFilters): boolean {
  return historyFiltersToParams(filters).toString() !== "";
}

export function parseTimezoneOffset(raw: string | null): number {
  if (raw === null || raw.trim() === "") return 0;
  const value = Number(raw);
  if (!Number.isInteger(value) || Math.abs(value) > MAX_TZ_OFFSET_MINUTES) {
    throw new HistoryFilterError("Invalid tzOffset: must be whole minutes between -840 and 840.");
  }
  return value;
}

export function parseTripIdFilter(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  if (!UUID_RE.test(raw.trim())) throw new HistoryFilterError("Invalid tripId.");
  return raw.trim();
}

// ─── Derived values ───────────────────────────────────────────────────────────

/** Lowercased search terms; every term must match somewhere in the expense. */
export function searchTerms(q: string): string[] {
  return q
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, MAX_SEARCH_TERMS);
}

/**
 * Converts inclusive local dates into a half-open UTC instant range.
 *
 * `tzOffsetMinutes` is `Date#getTimezoneOffset()` from the viewer's browser
 * (UTC minus local, so IST is -330). "To 2026-10-05" includes the whole of that
 * local day, so the upper bound is the following local midnight, exclusive.
 */
export function dateRangeBounds(
  from: string | null,
  to: string | null,
  tzOffsetMinutes: number,
): { fromIso: string | null; toIso: string | null } {
  const localMidnight = (date: string, addDays: number) => {
    const [y, m, d] = date.split("-").map(Number);
    return new Date(Date.UTC(y, m - 1, d + addDays) + tzOffsetMinutes * 60_000).toISOString();
  };
  return {
    fromIso: from ? localMidnight(from, 0) : null,
    toIso: to ? localMidnight(to, 1) : null,
  };
}

export function settlementStateOf(expense: Pick<Expense, "settled" | "shares">): ExpenseSettlementState {
  if (expense.settled) return "settled";
  return (expense.shares ?? []).some((share) => share.paid) ? "partial" : "unpaid";
}

/**
 * Everything free-text search looks at, lowercased.
 * Mirrors `public.expense_search_document()` in SQL.
 */
export function expenseSearchDocument(expense: Expense): string {
  return [
    expense.title,
    expense.description ?? "",
    expense.category ?? "",
    ...(expense.tags ?? []),
    ...(expense.members ?? []).flatMap((member) => [member.name, member.walletAddress ?? ""]),
    ...(expense.shares ?? []).map((share) => share.txHash ?? ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function payerMatches(expense: Expense, payer: string): boolean {
  if (expense.paidByMemberId === payer) return true;
  const payerMember = expense.members.find((member) => member.id === expense.paidByMemberId);
  return !!payerMember?.walletAddress && payerMember.walletAddress.toUpperCase() === payer.toUpperCase();
}

/**
 * Local evaluation of the filters — the offline/degraded path. Must agree with
 * `public.search_expenses()`; the tests in __tests__/expense/historyFilters.test.ts
 * pin the shared semantics.
 */
export function matchesExpenseHistoryFilters(
  expense: Expense,
  filters: ExpenseHistoryFilters,
  tzOffsetMinutes: number = new Date().getTimezoneOffset(),
): boolean {
  if (filters.category) {
    const category = expense.category ?? UNCATEGORIZED;
    if (category !== filters.category) return false;
  }

  if (filters.tags.length > 0) {
    const tags = new Set(expense.tags ?? []);
    if (!filters.tags.every((tag) => tags.has(tag))) return false;
  }

  if (filters.payer && !payerMatches(expense, filters.payer)) return false;

  if (filters.status !== "all") {
    const state = settlementStateOf(expense);
    if (filters.status === "open" ? state === "settled" : state !== filters.status) return false;
  }

  if (filters.asset && settlementAssetOf(expense) !== filters.asset) return false;

  if (filters.from || filters.to) {
    const { fromIso, toIso } = dateRangeBounds(filters.from, filters.to, tzOffsetMinutes);
    const created = new Date(expense.createdAt).getTime();
    if (fromIso && created < new Date(fromIso).getTime()) return false;
    if (toIso && created >= new Date(toIso).getTime()) return false;
  }

  const terms = searchTerms(filters.q);
  if (terms.length > 0) {
    const document = expenseSearchDocument(expense);
    if (!terms.every((term) => document.includes(term))) return false;
  }

  return true;
}

// ─── Keyset cursor ────────────────────────────────────────────────────────────

export interface HistoryCursor {
  /** The row's `created_at` exactly as the database returned it (µs precision). */
  createdAt: string;
  /** Tie-breaker for rows sharing a timestamp; null for a legacy timestamp-only cursor. */
  id: string | null;
}

/**
 * `created_at|id`. The timestamp is kept verbatim: Postgres stores
 * microseconds, and round-tripping through `Date#toISOString()` would truncate
 * them to milliseconds and make the next page repeat or skip rows.
 */
export function encodeHistoryCursor(createdAt: string, id: string): string {
  return `${createdAt}|${id}`;
}

export function decodeHistoryCursor(raw: string | null): HistoryCursor | null {
  if (raw === null || raw.trim() === "") return null;
  const value = raw.trim();
  const separator = value.lastIndexOf("|");
  const createdAt = separator === -1 ? value : value.slice(0, separator);
  const id = separator === -1 ? null : value.slice(separator + 1);

  if (Number.isNaN(new Date(createdAt).getTime()) || (id !== null && !UUID_RE.test(id))) {
    throw new HistoryFilterError(
      "Invalid cursor: must be an ISO 8601 date string or a cursor returned by a previous page.",
    );
  }
  return { createdAt, id };
}
