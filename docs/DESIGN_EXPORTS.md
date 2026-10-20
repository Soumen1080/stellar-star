# CSV/PDF export and portable trip archive (#324)

All exports live under the trip page's **Export** row; **Archive** on `/trips`
exports every trip.

| Export | Where it is built | Scope |
|---|---|---|
| CSV | Browser (`lib/export/tripExport.ts`) | Data RLS already loaded for this wallet |
| PDF summary | `/trips/[id]/summary`, then the browser's "Save as PDF" | Same |
| Archive (JSON) | `POST /api/exports/archive` | Server reads with the caller's session client |

## CSV

One `expense` row per expense, one `share` row per share, one `installment` row per
partial payment towards a share (#325, each with its own transaction hash), and an
`adjustment` row for every share marked paid without an on-chain transaction. Columns include category,
entered amount and currency, exchange rate, source and timestamp, settlement asset,
transaction hash and explorer URL (`CSV_HEADER`). Text cells starting with `= + - @`
are prefixed with `'` so spreadsheets do not run them as formulas.

## Precision

Amounts are the stored decimal strings and are never passed through `Number`.
`amount()` cells reject anything that is not a plain decimal, so `1e-7` cannot be
written. Sums go through `Money` (BigInt stroops). The archive declares
`"amountEncoding": "decimal-string"`.

## PDF summary

Per-asset balances (paid, share, outstanding), every expense and share, account
explorer links, and receipt (transaction) links when "Include receipt links" is on.
Only well-formed 64-hex hashes become links.

## Archive route

- **Scoped:** `createServerClientForToken(token)`, so RLS returns only the caller's
  trips and expenses. A requested `tripIds` entry outside that set returns 403.
- **Rate-limited:** 5 per wallet and 20 per IP per hour.
- **Audited:** every request (served, rate_limited, forbidden, failed) appends to
  `export_audit_events` (migration `0011`, append-only RLS), with a salted IP hash and
  the archive's SHA-256. If the audit write fails, the archive is not returned (503).
