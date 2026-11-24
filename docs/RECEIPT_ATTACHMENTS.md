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

## Upload pipeline (`POST /api/expenses/:id/receipts` and `/intent`)

1. **Upload intents (`POST /api/expenses/:id/receipts/intent`).** Callers obtain
   a short-lived upload intent (15 min TTL) before uploading large receipts.
   The intent establishes the authorized caller, target expense, and limits (#451).
2. **Session and membership.** The expense is read with the caller's own
   RLS-bound client. If RLS hides it, the route returns `404`, the same as for
   an id that doesn't exist, so ids can't be probed.
3. **Authorization.** Only the payer (or the expense creator) can attach;
   anyone else gets `403`.
4. **Streamed size limits.** Default limit is 4 MiB (`RECEIPT_MAX_BYTES`).
   Oversized bodies are rejected with `413` during streaming via `readLimitedFormData`
   before unbounded buffering.
5. **Magic-byte validation.** JPEG, PNG, WebP, HEIC/HEIF, and PDF. The true type
   is authoritatively derived from the file's magic bytes. Client metadata is never
   trusted: a declared type contradicting magic bytes is refused (`415`). Disguised
   executables (PE/MZ, ELF, Mach-O, Shell scripts) are detected and refused or quarantined.
6. **Malware scan → Quarantine → Atomic promote.** `scanReceipt()` scans for active
   PDF features (/JavaScript, /Launch, /EmbeddedFile, /SubmitForm, /ImportData),
   polyglots, event handlers, and executable headers. Flagged or suspicious files
   are kept quarantined under `quarantine/` with status `quarantined` and are NEVER
   promoted or served. Clean files are atomically promoted to `receipts/` with status
   `active`.
7. **Metadata & retention.** The row stores uploader wallet, timestamp, SHA-256
   checksum, size, content type, optional caption (≤ 200 chars), scan result, and
   `retain_until`. Abandoned upload intents and orphaned quarantine files are cleaned
   up automatically during the retention sweep.

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

## Managed Object Encryption, Access Logs, Key Rotation, and Crypto-Erasure (#453)

Bucket privacy alone is not a sufficient key policy for sensitive receipts and exports:
1. **Managed Encryption at Rest**: Object payloads are encrypted using AES-256-GCM. An Authenticated Additional Data (AAD) binding (`<storage_path>:<key_id>`) guarantees ciphertext cannot be replanted or tampered across different object paths or keys.
2. **Key Lifecycle & Staging Rotation**: Key states transition through `active`, `retiring`, `revoked`, and `erased`. `rotateObjectKey` and `POST /api/admin/objects/rotate` allow online, staging re-encryption of existing objects from old keys to target keys without service interruption.
3. **Object Access Audit Logging**: Every `encrypt`, `decrypt`, `read_metadata`, `rotate`, `delete`, and `crypto_erase` action is recorded in `public.object_access_logs`. Every log entry strictly correlates the incoming `request_id` (via `X-Request-Id`).
4. **Crypto-Erasure & Deletion Procedures**:
   - Object-level: `cryptoEraseObject` zeros out the stored initialization vector (IV) and authentication tag in `public.private_object_metadata`, rendering any lingering storage or backup copies cryptographically unrecoverable.
   - Key-level: `cryptoEraseKey` erases master key material in `public.object_encryption_keys`, providing instant crypto-erasure for all associated objects.
5. **Unauthorized Access Denial**: Metadata queries for unauthorized wallets fail closed with `403 Forbidden`, and access denials are recorded in the audit log.

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
