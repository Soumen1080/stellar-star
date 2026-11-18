# Stellar-star: 50 production-scale implementation issues

This replacement backlog contains exactly 50 independently deliverable, evidence-based changes for a million-user production service.

## Shared definition of done

- Add focused unit/integration tests plus authorization and failure-path coverage.
- Preserve decimal-string money values, RLS tenant isolation, and request-ID propagation.
- Database work includes a uniquely named migration, index/RLS analysis, rollback notes, and a query-plan fixture.
- Public errors use stable safe codes; detailed causes are only redacted telemetry.

## 001 - Fail closed without durable rate limiting

lib/auth/rateLimiter.ts falls back to an instance-local map if its RPC fails, multiplying limits across nodes. Production protected routes must return 503 if durable limiting is unavailable; memory mode is development/test only. Done: outage, local-dev, and metric-state tests pass.

## 002 - Trust forwarded IPs only from ingress

lib/auth/rateLimiter.ts accepts forwarded IP headers from direct callers. Add an ingress-aware, IPv4/IPv6-normalizing resolver and migrate every rate-limited route. Done: spoofed headers do not alter direct request keys and deployment fixtures resolve expected client IPs.

## 003 - Atomically claim idempotency keys

lib/idempotency/store.ts reads then upserts, allowing concurrent duplicate mutations. Implement a transactional RPC returning claimed, replay, conflict, or locked and atomically complete responses. Done: parallel tests execute once, conflicts return 409, and lease expiry recovery is safe.

## 004 - Require idempotency keys for public mutations

The wrapper permits missing keys. Require validated Idempotency-Key headers for public POST/PATCH/DELETE money, invitation, receipt, recurring, and support actions; document cron exemptions. Done: missing/oversized keys return 400 and retry tests replay original responses.

## 005 - Expire and redact idempotency response data

Completed idempotency JSON is unbounded and has no retention policy. Persist an allowlisted response summary/digest, cap size, add indexed TTL cleanup, and retain minimum audit facts. Done: oversized results are safe and replay works only within documented retention.

## 006 - Secure and schedule reconciliation work

app/api/settlement/reconciliation-worker/route.ts has no effective authorization and vercel.json does not schedule it. Require constant-time cron authentication or explicit staff access, cap batches, and schedule execution. Done: anonymous calls fail and runs record actor, duration, cap, and request ID.

## 007 - Move reconciliation to a leased queue

Reconciliation performs Horizon/RPC work inside HTTP and may time out or duplicate. Add SKIP LOCKED job claims, leases, heartbeats, backoff, and dead-letter handling. Done: duplicate workers cannot process a job, leases recover, and backlog throughput is load-tested.

## 008 - Make large archive exports asynchronous

app/api/exports/archive/route.ts fetches all trips/expenses and serializes in route memory. Use durable export jobs, paginated reads, compressed private artifacts, and expiring signed URLs. Done: million-row fixtures stay memory-bounded and artifacts are owner-scoped/audited.

## 009 - Batch archive permission checks

The archive route checks hasTripPermission once per trip. Add an RLS-safe batch permission query/RPC. Done: query count is constant from 1 to 1,000 trips, unauthorized IDs remain non-disclosing 403s, and plans use indexes.

## 010 - Enforce API request and response byte limits

Direct JSON/text parsing can consume memory before validation. Build shared media-type, declared-length, streamed-byte, schema validation with per-route caps. Done: oversized chunks return 413, wrong type returns 415, and fuzz tests cannot crash handlers.

## 011 - Standardize authenticated route guards

Routes parse tokens and create Supabase clients independently. Build one guard that verifies wallet session, creates an RLS client, and adds actor/request context before data access. Done: protected routes use it and static checks prohibit service-role clients in user paths.

## 012 - Hide internal errors from API clients

Several catches return error.message. Map failures to stable public code/messages and log causes only with request ID. Done: injected database/provider errors disclose no internals and support can locate detailed redacted cause by ID.

## 013 - Add database deadlines and query budgets

Server calls lack consistent timeout, query count, and route budgets. Add deadline propagation, query tracing, and statement/lock/idle transaction timeouts. Done: stalled queries end predictably and dashboards show DB calls, latency, and errors per route.

## 014 - Make migration identity immutable

Duplicate migration prefixes such as 0005, 0007, and 0008 make order filename-dependent. Introduce immutable IDs, checksums, manifest, and DB ledger. Done: CI rejects duplicates/reordering/changes and fresh/upgraded schemas match.

## 015 - Generate database types in CI

types/supabase can drift from SQL/RPC definitions. Generate it reproducibly from the migration schema and enforce a diff gate. Done: schema edits fail until types update and critical RPC boundaries are strongly typed.

## 016 - Partition high-volume operational data

Audit, events, notifications, and jobs will grow indefinitely. Partition time-series tables by month, add retention/archive rules and partition-aware indexes. Done: plans prune partitions, cleanup is efficient, and scale fixtures meet latency budget.

## 017 - Add a transactional outbox

State commits can succeed while reminders/webhooks/analytics fail. Persist outbox rows in the same transaction and dispatch them through leased retrying workers. Done: post-commit failures are replayed, events have trace IDs, and dedupe semantics are tested.

## 018 - Add Stellar circuit breakers and bulkheads

Horizon/Soroban faults can consume all capacity through retries. Add timeouts, bounded jitter, provider breakers, and separated concurrency pools. Done: fault tests open/recover breakers and one dependency cannot starve unrelated requests.

## 019 - Cache immutable chain metadata safely

Repeated asset, trustline, and contract reads load providers. Add bounded distributed cache with network-scoped keys, safe TTL/stale refresh, negative caching, and invalidation. Done: upstream calls fall, changed state is not wrongly stale, and data cannot cross tenants.

## 020 - Add provider health routing

Single Stellar, FX, OCR, and notification endpoints create vendor outages. Use health-checked provider interfaces with priority/fallback rules and consistency contracts. Done: failure fixtures select compatible fallback without duplicated payments; dashboards/runbooks support disablement.

## 021 - Deduplicate realtime subscriptions

lib/supabase/useRealtimeCollection.ts can create duplicate channels. Centralize channels by wallet/trip, ref-count consumers, narrow filters, jitter reconnect, and tear down reliably. Done: navigation cannot increase live channels and telemetry reports channel/event rates.

## 022 - Use keyset cursors for all large lists

Whole-collection and offset paths do not scale. Standardize opaque created-at plus ID cursors, finite limits, stable ordering, and incremental UI. Done: concurrent inserts do not duplicate/skip records and composite index plans are verified.

## 023 - Build indexed bounded expense search

History filtering needs full-text indexing and query controls. Add normalized search documents, RLS-scoped text indexes, ranking, minimum-query rules, and cursor paging. Done: million-row tests meet latency and pathological inputs cannot force scans.

## 024 - Quarantine and scan receipt uploads

Client metadata must not decide readable receipt content. Use short-lived upload intents, streamed limits, magic-byte validation, malware scan, quarantine, and atomic promote. Done: spoofed, oversized, or infected files are unavailable and abandoned uploads clean up.

## 025 - Move OCR to quota-controlled workers

OCR is CPU-heavy and should not block requests. Queue clean uploads, enforce per-user/trip quotas, isolate CPU/time, persist confidence/provenance, and require review before financial writes. Done: upload latency stays low and OCR load cannot starve APIs.

## 026 - Encrypt private objects with key rotation

Receipt/export bucket privacy is not sufficient key policy. Enable managed encryption, object access logs, rotation, and crypto-erasure/deletion procedures. Done: staging rotation succeeds, unauthorized metadata/object reads fail, and logs correlate request IDs.

## 027 - Define a versioned event envelope

Realtime, webhooks, analytics, and activity have no shared compatibility contract. Define event ID/type/time/actor/aggregate/causation/payload-version schemas and validate both ends. Done: incompatible changes fail CI and consumers safely ignore unknown fields.

## 028 - Create tamper-evident privileged audits

Support, role, export, and admin actions have scattered audit evidence. Append actor, decision, target, request ID, and chained hash entries; restrict mutation and anchor digests. Done: tampering is detectable and privileged routes are covered.

## 029 - Generate authorization contract tests

New API routes can omit access control tests. Maintain public/wallet/staff/cron route metadata and generate anonymous, wrong-wallet, expired, and authorized cases. Done: CI rejects unclassified routes and all protected endpoints pass their matrix.

## 030 - Tighten the Content Security Policy

next.config.mjs globally allows unsafe inline/eval scripts. Use nonce/hash policy, remove unsafe eval in production, minimize origins, and report violations through a protected endpoint. Done: core wallet/OCR/QR flows work under scanner-approved CSP.

## 031 - Make wallet challenges durable and one-time

Login challenge usage needs cross-instance replay protection. Persist hashed ID, wallet, origin, network, expiry, consumed timestamp and atomically consume it. Done: parallel verification works once and cross-origin/network/expired cases fail.

## 032 - Rotate JWT signing keys with key IDs

Static secret fallback prevents clean rotation. Support kid-selected active/previous keys, JWKS or approved verifier source, and overlap policy. Done: old/new tokens validate only during overlap, retired/unknown keys fail closed, and secrets never reach clients.

## 033 - Separate public and server environment config

Browser-prefixed values are bundled; modules mix public and secret config assumptions. Add typed publicEnv/serverEnv allowlists, startup checks, and bundle secret scans. Done: client code cannot import server settings and invalid production config stops safely.

## 034 - Test RLS against real Postgres

Application checks cannot replace database tenant boundaries. Test every table/view/function with two wallet claim sets; assert forced RLS and grant safety. Done: cross-wallet read/write/execute fails in DB tests and new tables require policy tests.

## 035 - Add tenant quotas and backpressure

One tenant can monopolize storage, queues, realtime, or providers. Atomically meter objects, bytes, jobs, event rate, and API requests with safe limit responses. Done: concurrency tests never exceed quota and no tenant can inspect another's usage.

## 036 - Protect hot trips from contention

Popular groups concentrate writes/subscriptions on small keys. Measure contention; apply optimistic versions or narrow locks, event coalescing, and per-aggregate backpressure. Done: p99 hot-aggregate writes meet SLO and stale versions give clear UX.

## 037 - Add performance load and soak gates

Current tests do not prove concurrent million-user behavior. Add reproducible login/read/write/export/settlement/reconnect scenarios with budgets. Done: CI runs smoke load, scheduled environments run peak/soak, and p50/p95/p99/errors/saturation gate regressions.

## 038 - Instrument OpenTelemetry end-to-end

Request IDs alone cannot show UI-to-worker causality. Add W3C context, redacted spans, sampling, and outbox propagation across browser/API/DB/Stellar/workers. Done: export/settlement traces are inspectable without exposing JWT, XDR, or receipt data.

## 039 - Define SLOs and error-budget alerts

Alerts lack measurable service objectives. Set SLOs for auth, reads, writes, payment submit, worker lag, realtime; create burn-rate alerts and degradation playbooks. Done: dashboards show demand/saturation/dependency health and game-day response is exercised.

## 040 - Add audited server-evaluated feature flags

Rollouts currently expose behavior to everyone. Create typed default-off flags with tenant/percentage targeting, cache safety, owner/expiry, audits, and kill switch. Done: rollout/backout needs no deploy and client edits cannot bypass authorization flags.

## 041 - Make cron jobs idempotent and overlap-safe

Recurring, reminder, and retention HTTP jobs can overlap/retry/skip. Add durable run records, leases, unique schedule windows, cursors, metrics, and privileged replay. Done: duplicates create no duplicate effects and missed windows are detected.

## 042 - Harden webhook delivery

Webhook recipients need signed durable delivery and abuse controls. Dispatch from outbox, sign timestamped canonical payloads, retry with jitter, disable persistent failures, and expose redacted diagnostics. Done: event IDs are idempotent and timeout/429/5xx cannot cause unbounded work.

## 043 - Enforce developer API compatibility

A v1 prefix does not prevent accidental contract breaks. Publish lifecycle/deprecation policy, OpenAPI diff checks, sunset headers, and fixtures. Done: CI flags breaks and every endpoint declares auth, paging, errors, idempotency, and limits.

## 044 - Delete account data everywhere

Account deletion must cover queues, objects, indexes, and logs, not only tables. Add a state machine to revoke sessions, cancel jobs, erase objects, anonymize lawful logs, and honor legal holds. Done: staging proves data absence after retention while keeping minimal legal evidence.

## 045 - Enforce immutable financial transitions

Expenses, shares, settlements, corrections, and disputes need one authoritative transition model. Add database state constraints/RPCs, append-only events, and conservation invariants. Done: API/direct RLS invalid transitions fail and property tests cover concurrent finance races.

## 046 - Drill database, storage, and queue recovery

Backup code needs evidence of full recovery. Automate encrypted verification, point-in-time DB restore, object inventory restore, and outbox recovery in isolation. Done: drill measures RPO/RTO and sampled trips, receipts, audits, and jobs reconcile.

## 047 - Add supply-chain provenance

Financial releases require build-input evidence and dependency controls. Generate SBOMs and signed provenance, enforce locks, scan dependencies/secrets, and automate reviewed updates. Done: artifacts are retrievable, critical findings gate releases, and updates run compatibility scans.

## 048 - Govern Soroban releases

Contract changes can break settlement assumptions. Version interface/storage, require multisig/timelock approval, simulate upgrade/revert, and verify deployed WASM/contract IDs against release metadata. Done: breaking ABI/storage needs migration and mismatches block unsafe payments.

## 049 - Establish incident command

Production incidents need authority and communications. Define severity, roles, customer templates, evidence handling, status updates, and postmortems in docs/RUNBOOK.md. Done: tabletops cover payment uncertainty/data exposure and alerts link tested runbooks.

## 050 - Gate release with a readiness scorecard

Current safety controls lack one verifiable promotion decision. Build machine-readable checks for migrations, RLS, performance, security, backups, dependencies, SLOs, contracts, and rollback with accountable exceptions. Done: failed requirements block promotion and overrides/evidence are audited.
