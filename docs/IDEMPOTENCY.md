# Idempotency keys for public mutations

Issue #413 (also tracking #412). Builds on the atomic claims from #411 (`lib/idempotency/store.ts`,
`migrations/0023_atomic_idempotency_claims.sql`).

A browser retry, a mobile reconnect or a double click can send the same
mutation twice. Every public mutation therefore requires an `Idempotency-Key`,
which the server checks before doing any work. The response to the first
successful request is stored and replayed for retries.

## Client contract

| Situation | Response |
| --- | --- |
| No key | `400` `IDEMPOTENCY_KEY_REQUIRED`. Nothing runs. |
| Malformed key | `400` `IDEMPOTENCY_KEY_INVALID`. Nothing runs. |
| First request with a key | Runs normally. A 2xx response is stored. |
| Retry, same key and same payload, after a 2xx, within 24 h | The original status and the route's allowlisted replay summary (see "What is stored"), plus `Idempotent-Replayed: true` and `Idempotency-Response-Digest`. Nothing runs again. |
| Retry of a 2xx whose summary exceeded 16 KiB | The original status with `{ "idempotentReplay": { "completed": true, "bodyOmitted": true, "digest": … } }`. Nothing runs again. |
| Same key more than 24 h after completion | The key is free again; the request runs as new. |
| Retry while the first request is still running | `409` `IDEMPOTENCY_IN_PROGRESS` with `Retry-After`. |
| Same key, different payload, after a 2xx | `409` `IDEMPOTENCY_CONFLICT`. |
| Retry after a non-2xx response | Runs again. A failed attempt changed nothing, so its key is released and can be reused, even with a corrected payload. |

A valid key:

- is sent in the `Idempotency-Key` header. `X-Idempotency-Key` is accepted as
  an alias, and a few older routes also accept an `idempotencyKey` JSON field
  (see below). When several sources are present they must agree;
- is 8–255 characters long;
- contains only visible ASCII (`0x21`–`0x7E`): no spaces, control characters
  or non-ASCII. It is not trimmed, so surrounding whitespace is rejected.

Use a UUID. Create one key for each user action, send the same key on every
retry of that action, and create a new key once it succeeds. The browser
helpers in `lib/idempotency/client.ts` do this
(`createIdempotencyKeyHolder`, `idempotencyHeaders`).

Keys belong to the authenticated principal: a wallet, `staff:<id>` for support
staff, or `operator:sponsorship` for the sponsorship operator. One principal
cannot replay another's response. The fingerprint covers method, path and
payload, so a key reused on a different route or resource gets a 409 and
never a cross-route replay.

Auth runs before the key check. An unauthenticated request still gets 401
(or 403), whether or not it has a key.

## What is stored (#414)

The raw response is never persisted. For a completed request the ledger keeps:

| Field | Purpose | Kept for |
| --- | --- | --- |
| `response_body` | The **replay summary**: only the fields the route lists in `replayFields`, capped at 16 KiB. | 24 h (`replay_expires_at`), then set to NULL (`redacted_at`) |
| `response_digest` | SHA-256 of the full original body, also sent as `Idempotency-Response-Digest: sha-256=<hex>` | 30 days |
| `response_bytes`, `replay_omitted` | Size of the original body, and whether the summary was too large to keep | 30 days |
| `key`, `wallet_address`, `endpoint`, `request_fingerprint`, `response_status`, `created_at`, `completed_at` | Minimum audit facts to explain a request | 30 days, then the row is deleted |

Allowlists live with the shapes they describe in `lib/idempotency/replay.ts`
(`EXPENSE_REPLAY_FIELDS`, `TRIP_REPLAY_FIELDS`, `RECEIPT_REPLAY_FIELDS`, …).
Each route passes its list as the required `replayFields` option. A field that
is not named is never stored, so a field added to a response later stays out
until someone adds it on purpose. Free text (descriptions, void and correction
reasons, reminder notes, support reasons and details, receipt captions),
contact data (e-mail address, push endpoint), checksums and storage internals
are excluded. A client that needs a field the summary leaves out re-reads the
resource.

Responses that carry a one-time secret (v1 API tokens, webhook signing
secrets, the invite URL with its join token), and the account-deletion result,
are kept only in the process-local ledger (`persist: false`) and never reach
the database.

### Retention and cleanup

- Replay window: `IDEMPOTENCY_REPLAY_TTL_SECONDS` = 24 h. The claim function
  ignores a completed record past its window, so a late retry starts a new
  request.
- Audit retention: `IDEMPOTENCY_AUDIT_RETENTION_DAYS` = 30 days.
- Abandoned pending claims (lease ended more than 24 h ago) are deleted.
- `GET /api/idempotency/cleanup` (Vercel Cron, daily at 04:15 UTC,
  `Authorization: Bearer $CRON_SECRET`) calls `purge_idempotency_records()`.
  The function works in batches of 1,000 using `FOR UPDATE SKIP LOCKED`
  through three partial indexes (`idx_idempotency_records_replay_expiry`,
  `idx_idempotency_records_completed_at`,
  `idx_idempotency_records_stale_pending`). It also sweeps the instance's
  process-local ledger, which is capped at 10,000 records.
- Migration 0024 redacted every body stored before this change, because those
  were stored without an allowlist.

### Ledger access

The ledger functions no longer accept anonymous callers. A wallet session can
only claim, complete or release keys for the wallet in its own JWT
(`assert_idempotency_principal`). Service-role callers (v1 API, support staff)
are unrestricted, and only the service role can run the purge.

## Server pattern

```ts
const idempotency = requireIdempotencyKey(request);   // 400 if absent/malformed
if (!idempotency.ok) return idempotency.response;

return runIdempotentMutation({
  request,
  client,                       // RLS client for the durable ledger
  key: idempotency.key,
  replayFields: ["data.id", "data.status"], // what a retry may get back
  principal: session.wallet_address,
  payload: body,                // what makes a retry "the same request"
  execute: async () => { /* state checks + the mutation */ return NextResponse.json(...); },
});
```

- **State checks belong inside `execute`.** A check such as "already voided?",
  "still active?" or an optimistic-concurrency version fails on a retry of a
  request that already succeeded. If it runs before the claim, the retry gets
  that failure instead of the replay. Static validation (body shape, auth) can
  stay outside.
- **`persist: false`** keeps a replay in the process-local ledger only. It is
  used where the response contains a one-time secret (API token, webhook
  signing secret), where the state lives in process memory (v1 tokens and
  webhooks), and for account deletion, which must not create a new row for the
  wallet it just erased.
- v1 routes pass `requireIdempotencyKey: true` to `authenticateApiRequest`,
  which returns the developer-API error envelope.
- `withIdempotency` throws `IdempotencyKeyError` (400) for a missing or invalid
  key, so the wrapper can't be used without one.

The body field (`idempotencyKey`) is still accepted on `/api/expenses`,
`/api/trips`, `/api/invitations/create` and `/api/invitations/claim`, the
routes that accepted it before #412. Offline expense drafts queued by older
clients keep working. New routes accept only the header.

## Routes that require a key

`lib/idempotency/policy.ts` is the source of truth. The test
`__tests__/security/requiredIdempotencyKeys.test.ts` scans `app/api` and fails
for any mutating handler that is in neither table, and for any required route
that does not call `requireIdempotencyKey` and `runIdempotentMutation`.

| Route | Methods | Category |
| --- | --- | --- |
| `/api/expenses` | POST | money |
| `/api/expenses/[id]` | PATCH | money |
| `/api/expenses/[id]/correct` | POST | money |
| `/api/expenses/[id]/void` | POST | money |
| `/api/trips` | POST | money |
| `/api/settlement/attest` | POST | money |
| `/api/onboarding/sponsor` | POST | money |
| `/api/onboarding/revoke` | POST | money |
| `/api/invitations/create` | POST | invitation |
| `/api/invitations/claim` | POST | invitation |
| `/api/invitations/revoke` | POST | invitation |
| `/api/expenses/[id]/receipts` | POST | receipt |
| `/api/receipts/[receiptId]` | DELETE | receipt |
| `/api/reminders` | POST | recurring |
| `/api/reminders/[id]` | PATCH | recurring |
| `/api/reminders/schedules` | POST, DELETE | recurring |
| `/api/support/actions/propose` | POST | support |
| `/api/support/actions/approve` | POST | support |
| `/api/trips/[id]/members/[memberId]/role` | PATCH | trip-governance |
| `/api/trips/[id]/transfer-ownership` | POST | trip-governance |
| `/api/account/delete` | POST, DELETE | account |
| `/api/v1/trips` | POST | developer-api |
| `/api/v1/expenses` | POST | developer-api |
| `/api/v1/tokens` | POST | developer-api |
| `/api/v1/tokens/[id]` | DELETE | developer-api |
| `/api/v1/webhooks` | POST | developer-api |
| `/api/v1/webhooks/[id]` | DELETE | developer-api |
| `/api/v1/webhooks/test` | POST | developer-api |

## Exemptions

These routes are narrow and documented. Each one is protected some other way.

| Route | Methods | Kind | What protects it instead |
| --- | --- | --- | --- |
| `/api/recurring/run` | POST | scheduled-job | Vercel Cron with CRON_SECRET. Drafts are unique on (template_id, occurrence_date), so overlapping or repeated runs create nothing new. |
| `/api/idempotency/cleanup` | POST | scheduled-job | Vercel Cron with CRON_SECRET. The retention sweep is batched and convergent: re-running only finds less to redact or delete. |
| `/api/reminders/run` | POST | scheduled-job | Vercel Cron with CRON_SECRET. Each schedule's next_run_at advances after a send, and per-pair rate limits suppress duplicates. |
| `/api/receipts/retention` | POST | scheduled-job | Vercel Cron with CRON_SECRET. Purging an already-purged receipt is a no-op. |
| `/api/outbox/worker` | POST | scheduled-job | CRON_SECRET-authenticated worker. Outbox rows are claimed with leases and delivered at least once by design. |
| `/api/settlement/reconciliation-worker` | POST | scheduled-job | Cron secret or explicit staff credentials only (#415); runs are bounded and recorded, and every intent it touches is keyed by the derived settlement idempotency key. Jobs are leased (#416), so overlapping runs never process one job; enqueue dedupes per intent and requeue only moves a job out of dead_letter. |
| `/api/developer/reconciliation` | POST | scheduled-job | Re-export of POST /api/settlement/reconciliation-worker for the developer dashboard; same protection. |
| `/api/settlement/reconcile` | POST | derived-key | Deduplicates on a server-derived key (txHash + expenseId + memberId + asset) backed by a unique constraint; also serves anonymous webhook re-syncs, which have no principal to scope a client key to. |
| `/api/auth/verify` | POST | session | Exchanges a single-use signed challenge for a session; a replayed challenge is rejected. |
| `/api/auth/refresh` | POST | session | Re-issues a session token; repeating it only yields another valid token. |
| `/api/analytics/events` | POST | telemetry | Best-effort analytics beacon; duplicates are tolerated by aggregation. |
| `/api/error-report` | POST | telemetry | Best-effort error telemetry; duplicates are tolerated. |
| `/api/analytics/database-performance` | POST | operator-diagnostic | Runs a simulated query for the budgets panel; changes no business data. |
| `/api/developer/providers` | POST | operator-diagnostic | Process-local operator controls: set a provider's enabled flag to an explicit value, run a health check, or reset its stats; repeats converge. |
| `/api/developer/stellar-cache` | POST | operator-diagnostic | Clears or invalidates a process-local cache; repeats converge. |
| `/api/developer/stellar-resilience` | POST | operator-diagnostic | Resets process-local circuit breakers; repeats converge. |
| `/api/support/lookup` | POST | read-only | Read-only incident lookup sent as POST to keep identifiers out of URLs; only appends an audit entry. |
| `/api/exports/archive` | POST | read-only | Builds a download of the caller's own data; only appends an export audit entry. |
| `/api/onboarding/sponsor` | DELETE | read-only | Despite the verb, lists the caller's revocable sponsorships; the revocation itself is POST /api/onboarding/revoke. |
| `/api/reminders/preferences` | PUT | naturally-idempotent | Sets preference fields to the given values; repeating the same PUT converges. |
| `/api/reminders/unsubscribe` | POST | naturally-idempotent | One-click e-mail unsubscribe (RFC 8058) authorized by a signed token; mail clients cannot add headers, and opting out twice converges. |

## Adding a mutating route

1. Add it to `IDEMPOTENCY_REQUIRED_ROUTES`. If it is an exemption, add it to
   `IDEMPOTENCY_EXEMPT_ROUTES` with a reason that says what protects it.
2. Call `requireIdempotencyKey` right after authentication.
3. Wrap the state checks and the mutation in `runIdempotentMutation`, with a
   `replayFields` allowlist that names only what a retry needs.
4. Send a key from every caller and list the route here.

## Known limits

- **Non-JSON bodies.** Every route in scope responds with JSON. Only the digest
  of a non-JSON body is stored, and its replay body is `null`. Only
  `Cache-Control` and any route-specific `replayHeaders` are carried over.
- **Reuse after the window.** Like other idempotency-key APIs, a retry sent
  more than 24 hours after the original runs again. Clients should not keep
  retrying the same key for longer than that.
