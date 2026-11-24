/**
 * lib/pagination/keyset.ts
 *
 * Opaque keyset cursors over (created_at DESC, id DESC) for every large list
 * (#449).
 *
 * Offset paging re-counts every skipped row, and rows inserted while a reader
 * pages shift the offsets: rows get duplicated or skipped. A timestamp-only
 * cursor (`created_at < X`) skips every row sharing the boundary timestamp.
 * A cursor holding the full sort key, compared as a tuple, avoids both. Rows
 * inserted after page 1 are newer than every cursor, so they can never appear
 * on (or push rows off) a later page.
 *
 *   next page := created_at < c  OR (created_at = c AND id < i)
 *
 * The cursor is opaque to clients (`v1.` + base64url JSON), so the encoding
 * can change without breaking callers. The timestamp is kept verbatim:
 * Postgres stores microseconds, and round-tripping through
 * `Date#toISOString()` would truncate them to milliseconds and repeat rows.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface KeysetCursor {
  /** `created_at` exactly as the database returned it. */
  createdAt: string;
  /** Tie-breaker. Null only for a legacy timestamp-only cursor. */
  id: string | null;
}

export interface KeysetPage<T> {
  data: T[];
  pagination: {
    limit: number;
    nextCursor: string | null;
    hasMore: boolean;
  };
}

export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

const PREFIX = "v1.";
// Strict: these values are interpolated into a PostgREST filter expression.
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_CURSOR_LENGTH = 256;

const INVALID_CURSOR =
  "Invalid cursor: must be a cursor returned by a previous page (or a legacy ISO 8601 timestamp).";

function toBase64Url(text: string): string {
  return Buffer.from(text, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  return Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
}

function validTimestamp(value: string): boolean {
  return TIMESTAMP_RE.test(value) && !Number.isNaN(new Date(value).getTime());
}

export function encodeCursor(createdAt: string, id: string): string {
  if (!validTimestamp(createdAt) || !UUID_RE.test(id)) {
    throw new CursorError("Cannot encode a cursor without a valid created_at and UUID id.");
  }
  return PREFIX + toBase64Url(JSON.stringify({ c: createdAt, i: id }));
}

/**
 * Decodes an opaque cursor. Also accepts the two formats clients may still
 * hold: `created_at|id` (expense history) and a bare ISO timestamp.
 */
export function decodeCursor(raw: string | null | undefined): KeysetCursor | null {
  if (raw === null || raw === undefined) return null;
  const value = raw.trim();
  if (value === "") return null;
  if (value.length > MAX_CURSOR_LENGTH) throw new CursorError(INVALID_CURSOR);

  if (value.startsWith(PREFIX)) {
    let parsed: { c?: unknown; i?: unknown };
    try {
      parsed = JSON.parse(fromBase64Url(value.slice(PREFIX.length)));
    } catch {
      throw new CursorError(INVALID_CURSOR);
    }
    if (typeof parsed.c !== "string" || typeof parsed.i !== "string" || !validTimestamp(parsed.c) || !UUID_RE.test(parsed.i)) {
      throw new CursorError(INVALID_CURSOR);
    }
    return { createdAt: parsed.c, id: parsed.i.toLowerCase() };
  }

  const separator = value.lastIndexOf("|");
  const createdAt = separator === -1 ? value : value.slice(0, separator);
  const id = separator === -1 ? null : value.slice(separator + 1);
  if (!validTimestamp(createdAt) || (id !== null && !UUID_RE.test(id))) {
    throw new CursorError(INVALID_CURSOR);
  }
  return { createdAt, id: id?.toLowerCase() ?? null };
}

/** Finite, positive page size; anything above MAX_PAGE_SIZE is clamped. */
export function parseLimit(raw: string | number | null | undefined, fallback = DEFAULT_PAGE_SIZE): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new CursorError("Invalid limit: must be a positive integer.");
  }
  return Math.min(parsed, MAX_PAGE_SIZE);
}

/**
 * PostgREST `or=` expression selecting rows strictly after `cursor` in
 * (created_at DESC, id DESC) order. Values are double-quoted, which PostgREST
 * requires for timestamps containing `:` or `+`.
 */
export function keysetOrFilter(cursor: KeysetCursor, column = "created_at"): string {
  if (!validTimestamp(cursor.createdAt) || (cursor.id !== null && !UUID_RE.test(cursor.id))) {
    throw new CursorError(INVALID_CURSOR);
  }
  const c = `"${cursor.createdAt}"`;
  if (cursor.id === null) return `${column}.lt.${c}`;
  return `${column}.lt.${c},and(${column}.eq.${c},id.lt.${cursor.id})`;
}

/** Minimal builder surface shared by Supabase query builders. */
interface OrderableQuery<Q> {
  order(column: string, options: { ascending: boolean }): Q;
  or(filter: string): Q;
  limit(count: number): Q;
}

/**
 * Applies stable ordering, the keyset predicate and `limit + 1` (one extra
 * row tells us whether another page exists without a count(*)).
 */
export function applyKeyset<Q extends OrderableQuery<Q>>(query: Q, cursor: KeysetCursor | null, limit: number): Q {
  let q = query.order("created_at", { ascending: false }).order("id", { ascending: false });
  if (cursor) q = q.or(keysetOrFilter(cursor));
  return q.limit(limit + 1);
}

/** Splits a `limit + 1` result into a page and the next cursor. */
export function toKeysetPage<T>(
  rows: T[],
  limit: number,
  key: (row: T) => { createdAt: string; id: string },
): KeysetPage<T> {
  const hasMore = rows.length > limit;
  const data = hasMore ? rows.slice(0, limit) : rows;
  const last = data[data.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(key(last).createdAt, key(last).id) : null;
  return { data, pagination: { limit, nextCursor, hasMore } };
}

/** (created_at DESC, id DESC) comparator for in-memory fallbacks. */
export function compareKeysetDesc(a: { createdAt: string; id: string }, b: { createdAt: string; id: string }): number {
  const ta = timestampKey(a.createdAt);
  const tb = timestampKey(b.createdAt);
  if (ta !== tb) return ta < tb ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** True when `row` sorts strictly after `cursor` (belongs on a later page). */
export function isAfterCursor(row: { createdAt: string; id: string }, cursor: KeysetCursor): boolean {
  const tr = timestampKey(row.createdAt);
  const tc = timestampKey(cursor.createdAt);
  if (tr !== tc) return tr < tc;
  return cursor.id !== null && row.id.toLowerCase() < cursor.id;
}

/**
 * Comparable microsecond key. Keeps sub-millisecond digits that Date would
 * drop, so in-memory ordering matches Postgres.
 */
function timestampKey(value: string): string {
  const ms = new Date(value).getTime();
  const frac = /\.(\d{1,6})/.exec(value)?.[1] ?? "";
  const micros = (frac + "000000").slice(3, 6);
  return `${String(Math.floor(ms)).padStart(16, "0")}${micros}`;
}
