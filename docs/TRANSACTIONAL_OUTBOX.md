# Transactional Outbox Pattern Architecture & Operations

This document describes the design, database schema, concurrency mechanics, retry lifecycle, and operational procedures for the **Transactional Outbox Pattern** in Stellar-star (#425 / Issue 017).

---

## 1. Motivation & Problem Statement

In distributed financial architectures, operations typically produce both an internal state change (e.g. creating an expense, recording a settlement intent, updating ledger balances) and external consequences:
- **Webhooks**: Notifying third-party accounting integrations, partner services, and event subscribers.
- **Payment Reminders**: Pushing notifications or emails to debtor members.
- **Analytics & Telemetry**: Emitting operational events for product and fraud intelligence.

### The Dual-Write Hazard

When financial mutations and external dispatches are executed independently without an atomic outbox, failure conditions create permanent inconsistencies:

```
┌───────────────────────────────────────────────┐
│     Client Mutation (e.g. Create Expense)     │
└──────────────────────┬────────────────────────┘
                       │
         ┌─────────────▼─────────────┐
         │ Commit State Transaction  │  ==> SUCCESS (State permanently changed)
         └─────────────┬─────────────┘
                       │
         ┌─────────────▼─────────────┐
         │ Dispatch External Webhook │  ==> FAILED (Network timeout / ECONNREFUSED / 5xx)
         └───────────────────────────┘
```

If the database transaction commits and the subsequent webhook, reminder, or analytics call fails:
- The system has **permanently changed state without publishing its consequence**.
- An external recipient never receives notice of money owed or settled.
- Conversely, calling external services *before* database commit risks publishing ghost events if the transaction rolls back.

### Solution: Transactional Outbox

The **Transactional Outbox Pattern** couples the financial state change and its consequence into the **exact same database transaction**:
1. An outbox row written in the same transaction creates a **durable promise to dispatch later**.
2. If the transaction rolls back, no outbox row is stored (preventing phantom notifications).
3. If the transaction commits, the consequence is durably guaranteed to be dispatched.
4. **Leased background workers** poll the outbox table via `SELECT ... FOR UPDATE SKIP LOCKED` and deliver messages with automatic deduplication, exponential backoff, and distributed trace context.

---

## 2. Architecture & Data Flow

```
┌────────────────────────────────────────────────────────┐
│             Financial Mutation Boundary                │
│                                                        │
│  BEGIN TRANSACTION;                                    │
│    INSERT INTO expenses (...) VALUES (...);            │
│    INSERT INTO transactional_outbox (...) VALUES (...);│
│  COMMIT;                                               │
└───────────────────────────┬────────────────────────────┘
                            │
               ┌────────────▼────────────┐
               │  public.transactional_  │
               │         outbox          │
               │   (status = 'pending')  │
               └────────────┬────────────┘
                            │
   Worker Leases Batch via  │  SELECT ... FOR UPDATE SKIP LOCKED
                            ▼
               ┌─────────────────────────┐
               │   Leased Outbox Worker  │
               │   (Worker ID, Lease TTL)│
               └────────────┬────────────┘
                            │
              ┌─────────────┴─────────────┐
              ▼                           ▼
     [External Dispatch]         [Failure with Backoff]
     - Webhook (HMAC signed)     - Exponential backoff + jitter
     - Payment Reminder Push     - Status => 'failed'
     - Analytics Telemetry       - Status => 'dead_letter' (max retries)
              │
              ▼
   complete_outbox_event()
   Status => 'delivered'
```

---

## 3. Database Schema & Indexes

The outbox table and stored procedures are provisioned in `migrations/0022_transactional_outbox.sql` and synchronized in `supabase-setup.sql`.

### 3.1 Table Definition: `public.transactional_outbox`

```sql
CREATE TABLE IF NOT EXISTS public.transactional_outbox (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type      TEXT NOT NULL,
  aggregate_id        TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  channel             TEXT NOT NULL CHECK (channel IN ('webhook', 'reminder', 'analytics')),
  payload             JSONB NOT NULL,
  headers             JSONB NOT NULL DEFAULT '{}'::jsonb,
  trace_id            TEXT NOT NULL,
  deduplication_key   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'leased', 'delivered', 'failed', 'dead_letter')),
  attempts            INT NOT NULL DEFAULT 0,
  max_attempts        INT NOT NULL DEFAULT 5,
  backoff_ms          INT NOT NULL DEFAULT 1000,
  lease_id            TEXT,
  leased_at           TIMESTAMPTZ,
  lease_expires_at    TIMESTAMPTZ,
  next_attempt_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_attempt_at     TIMESTAMPTZ,
  delivered_at        TIMESTAMPTZ,
  error_message       TEXT,
  created_by_wallet   TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_transactional_outbox_dedup UNIQUE (deduplication_key)
);
```

### 3.2 Performance & Queue Polling Indexes

| Index Name | Column(s) | Purpose |
|---|---|---|
| `uq_transactional_outbox_dedup` | `(deduplication_key)` UNIQUE | Enforces at-most-once enqueue serialization |
| `idx_transactional_outbox_polling` | `(status, next_attempt_at)` | High-throughput queue polling for due jobs |
| `idx_transactional_outbox_lease` | `(status, lease_expires_at)` | Fast identification of expired leases for recovery |
| `idx_transactional_outbox_trace` | `(trace_id)` | Correlation lookup across distributed tracing spans |
| `idx_transactional_outbox_aggregate`| `(aggregate_type, aggregate_id)` | Fast lookup by parent expense or settlement intent |
| `idx_transactional_outbox_created_at`| `(created_at DESC)` | Keyset pagination and operational log inspection |

---

## 4. Concurrency & Leased Worker Semantics

To support concurrent serverless workers and multi-replica clusters without race conditions:

### 4.1 Non-Blocking Batch Claims (`claim_outbox_batch`)

Workers claim jobs atomically using `FOR UPDATE SKIP LOCKED`:

```sql
WITH claimable AS (
  SELECT id
  FROM public.transactional_outbox
  WHERE
    (status = 'pending' AND next_attempt_at <= NOW())
    OR (status = 'leased' AND lease_expires_at < NOW())
    OR (status = 'failed' AND attempts < max_attempts AND next_attempt_at <= NOW())
  ORDER BY next_attempt_at ASC, created_at ASC
  LIMIT p_batch_size
  FOR UPDATE SKIP LOCKED
)
UPDATE public.transactional_outbox t
SET
  status = 'leased',
  lease_id = p_worker_id,
  leased_at = NOW(),
  lease_expires_at = NOW() + (p_lease_duration_seconds || ' seconds')::INTERVAL,
  attempts = t.attempts + 1,
  last_attempt_at = NOW(),
  updated_at = NOW()
FROM claimable c
WHERE t.id = c.id
RETURNING t.*;
```

**Guarantees**:
1. **Zero Lock Contention**: Concurrent workers skip already-locked rows without waiting or blocking.
2. **Worker Lease Recovery**: If a worker node crashes or times out while holding a lease, `lease_expires_at < NOW()` allows another worker to automatically reclaim the job.
3. **Strict Deduplication**: Two workers will never process the same record at the same time.

---

## 5. Exponential Backoff with Jitter & Dead-Letter Queue

Transient network errors (e.g. rate limits, 502/503/504 gateways) are retried with exponential backoff and randomized jitter:

$$\text{backoffMs} = \min\left(\text{baseBackoffMs} \times 2^{\text{attempts} - 1},\, \text{maxBackoffMs}\right) \times (1 \pm \text{jitter})$$

- **Base backoff**: 1,000 ms
- **Max backoff**: 60,000 ms
- **Jitter**: $\pm 20\%$

When `attempts >= max_attempts` (default 5):
- The event transitions to `dead_letter`.
- The sanitized error telemetry is recorded in `error_message`.
- It is excluded from routine polling queries, preventing stalled jobs from blocking queue throughput.
- Operators can inspect and re-drive dead-letter messages via administrative tools.

---

## 6. Distributed Trace Context & Money Preservation

### 6.1 W3C Trace Context Propagation
Every outbox row captures the request's W3C `traceparent` or correlation ID (`trace_id`). When dispatching to downstream targets:
- `traceparent`: Forwarded in standard W3C format.
- `X-Stellar-Trace-ID`: Propagates causality to logs and telemetry.
- `X-Stellar-Deduplication-Key`: Allows external webhook consumers to discard duplicate transmissions.
- `X-Stellar-Outbox-ID`: Direct link to outbox ledger.

### 6.2 Decimal-String Money Preservation
Financial values are strictly stored and serialized as decimal strings (e.g. `"1234567.8901234"`). Floating-point conversions (`parseFloat`) are prohibited to guarantee zero precision loss across currency and token calculations.

---

## 7. Operational Endpoints & CLI Commands

### 7.1 Outbox Worker Trigger Endpoint

- **Endpoint**: `/api/outbox/worker`
- **Methods**:
  - `GET`: Queries current queue metrics (pending, leased, delivered, failed, dead_letter counts).
  - `POST`: Leases and executes a worker run. Authenticated via `Authorization: Bearer $CRON_SECRET`.

### 7.2 Rollback Instructions

To roll back Migration 0022:

```sql
DROP TABLE IF EXISTS public.transactional_outbox CASCADE;
DROP FUNCTION IF EXISTS public.claim_outbox_batch(TEXT, INT, INT);
DROP FUNCTION IF EXISTS public.complete_outbox_event(UUID, TEXT);
DROP FUNCTION IF EXISTS public.fail_outbox_event(UUID, TEXT, TEXT, INT);
DROP FUNCTION IF EXISTS public.enqueue_outbox_event(TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, TEXT, JSONB, TEXT, INT, INT);
DELETE FROM public.schema_migrations WHERE version = '0022';
```
