# Receipt attachments (#318)

A payer can attach a bill, invoice, or receipt to an expense. Receipts often
contain personal data (names, addresses, partial card numbers), so they never
go into this repository, the public blockchain, or any public URL.

## Storage

| Piece | Where | Who can touch it |
|---|---|---|
| File bytes | Supabase Storage bucket `expense-receipts`, **private** | Only the server, with `SUPABASE_SERVICE_ROLE_KEY`. No `storage.objects` policies exist, so `anon`/`authenticated` cannot list, read, or write. |
| Metadata | `public.expense_receipts` | Members of the parent expense can **read** it (RLS, same `member_wallets` rule as expenses). No client write policies; every write goes through the API. |

Object keys are `receipts/<expenseId>/<receiptId>.<ext>`, built only from
server-generated ids. The uploaded file name is kept as display metadata and
never becomes part of a path. Without the service-role key, the receipt
endpoints return `503` and the rest of the app works as before.

## Upload pipeline (`POST /api/expenses/:id/receipts`)

1. **Session and membership.** The expense is read with the caller's own
   RLS-bound client. If RLS hides it, the route returns `404`, the same as for
   an id that doesn't exist, so ids can't be probed.
2. **Authorization.** Only the payer (or the expense creator) can attach;
   anyone else gets `403`.
3. **Size.** Default limit is 4 MiB (`RECEIPT_MAX_BYTES`). Oversized bodies are
   refused with `413` before they're buffered. The limit stays under typical
   serverless request-body caps. On the client, large JPEG/PNG/WebP photos are
   re-encoded to fit.
4. **Type allowlist.** JPEG, PNG, WebP, HEIC/HEIF, and PDF. The type comes from
   the file's magic bytes. A declared type that contradicts them is refused
   (`415`). An uninformative declared type (`application/octet-stream`, or
   empty, which mobile camera captures often send) is resolved by sniffing.
   SVG and HTML are never accepted.
5. **Scan → store or quarantine.** `scanReceipt()` is a static heuristic
   scanner, not antivirus. It flags PDFs with JavaScript, launch actions,
   embedded files, RichMedia, XFA, or encryption, and any file containing
   script/HTML/PHP markers (polyglots). Flagged files are stored under
   `quarantine/` with status `quarantined`. They're never signed or served, but
   they're kept so a false positive can be reviewed instead of losing the
   user's receipt. To use a real scanner (for example a ClamAV sidecar or a
   cloud AV API), replace `scanReceipt` with a call to it that returns the same
   `ScanResult` shape.
6. **Metadata.** The row stores the uploader wallet, timestamp, SHA-256
   checksum, size, content type, an optional caption (≤ 200 chars), the scan
   result, and `retain_until`. Uploading the same bytes to the same expense
   twice returns `409`. An expense can have at most 10 live receipts.

## Download (`GET /api/receipts/:receiptId`)

Every request re-checks membership through RLS, then returns a signed URL that
lives **60 seconds**, together with its `expiresAt`. The client never opens a
link within 5 s of expiry; it asks for a new one (`freshReceiptLink`). A member
who loses access stops getting links on their next request, and a leaked link
stops working within a minute. Quarantined receipts return `403`, removed ones
`410`.

## Retention and removal

- `DELETE /api/receipts/:receiptId`: the uploader or the expense creator can
  remove a receipt. The file is deleted. The row becomes a tombstone that keeps
  who removed it, when, and why, but drops the file name and caption.
- `retain_until` defaults to 730 days after upload (`RECEIPT_RETENTION_DAYS`).
- Deleting an expense sets `expense_id` to NULL instead of cascading, so the
  file isn't silently orphaned.
- `GET /api/receipts/retention` with `Authorization: Bearer $CRON_SECRET` (for
  example from Vercel Cron) purges expired receipts and receipts whose expense
  was deleted. Without `CRON_SECRET` the endpoint is disabled.

## Tests

- `__tests__/receipts/inspect.test.ts`: type sniffing, allowlist, size, mobile
  captures, quarantine heuristics, file-name sanitizing, access rules.
- `__tests__/receipts/routes.test.ts`: access denial (no session, non-member,
  non-payer, quarantined, removed), mobile upload, removal, retention auth.
- `__tests__/receipts/store.test.ts`: signed-URL TTL, quarantine never signed,
  object cleanup when the metadata write fails.
- `__tests__/receipts/client.test.ts`: expired-link handling.
- `__tests__/components/expenses/ExpenseReceipts.test.tsx`: camera capture
  input, upload, hidden controls for non-payers, access-denied message.
- `__tests__/database/receiptsSchema.test.ts`: private bucket, read-only RLS,
  no cascade.
