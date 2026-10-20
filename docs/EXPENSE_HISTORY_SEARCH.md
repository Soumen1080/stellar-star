# Expense categories, tags, and searchable history (#317)

Organization for long trips. The financial model doesn't change: categories and
tags are labels only, and nothing reads them when computing amounts or
settlements.

## Data model

| Column | Type | Notes |
|---|---|---|
| `category` | `TEXT NULL` | One of `EXPENSE_CATEGORIES` (`lib/expense/categories.ts`), enforced by `expenses_category_check`. `NULL` = uncategorized. |
| `tags` | `TEXT[] NOT NULL DEFAULT '{}'` | Normalized by `trg_05_expenses_normalize_labels`, at most 10 tags (`expenses_tags_limit_check`). |
| `settlement_asset` | `TEXT NULL` | Canonical asset key; `NULL` = native XLM. Frozen on update by `freeze_row_identity()`, the same as the amount. |

Tag normalization (`normalizeTag` in TS, `normalize_expense_tags` in SQL):
lowercase, a leading `#` removed, runs of non-alphanumerics become `-`,
hyphens trimmed from both ends, capped at 32 characters, duplicates removed.
`#Beach Day`, `beach-day` and `BEACH_DAY` all become `beach-day`.

## Query API

`GET /api/expenses` (Bearer wallet session). All parameters are optional:

| Param | Meaning |
|---|---|
| `q` | Free text. Every whitespace-separated term must appear in the title, description, category, tags, member names and wallets, or share tx hashes. |
| `category` | A category key or `uncategorized` |
| `tags` | Comma-separated. The expense must carry all of them. |
| `payer` | Payer member id or payer wallet address |
| `status` | `open` (not settled) · `unpaid` · `partial` · `settled` |
| `asset` | `native`/`XLM` or `CODE:ISSUER` |
| `from`, `to` | Inclusive `YYYY-MM-DD` in the viewer's local time |
| `tzOffset` | Viewer's `Date#getTimezoneOffset()`, used to turn `from`/`to` into instants |
| `tripId` | Limit results to one trip's expenses |
| `limit`, `cursor` | Page size (max 100) and the `nextCursor` from the previous page |

Invalid values return `400`. Filtering runs in `public.search_expenses()`, which
is `SECURITY INVOKER`, so the caller's RLS policies on `expenses` and `trips`
decide visibility, the same as for a plain `SELECT`. Pagination is keyset on
`(created_at, id)`, which stays stable while new rows are inserted. The cursor
keeps the database's microsecond timestamp unchanged.

## Client

- `useHistoryUrlState` mirrors the filters into the page URL through the
  History API, so a filtered view survives a reload and can be shared as a link.
- `useExpenseHistory` fetches one page at a time and refetches when the realtime
  collection changes. With no session, offline, or the migration not applied,
  it falls back to `matchesExpenseHistoryFilters` over cached expenses. That
  function has the same semantics as the SQL, and
  `__tests__/expense/historyFilters.test.ts` tests them.
- Accessibility: every control has a visible or screen-reader label. The
  advanced panel is a disclosure button (`aria-expanded`/`aria-controls`). Tags
  are added with Enter and removed with named buttons. Result counts are
  announced through a polite live region.
