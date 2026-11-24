# Database Deadlines and Query Budgets

## Overview & Architecture (#421)

An unconstrained database query can occupy a connection indefinitely, hold locks, and cascade into total service exhaustion under load.

This architecture enforces **propagated request deadlines**, **statement/lock/idle-transaction timeouts**, and **per-route query budgets**, ensuring that:
1. Every server request operates within an explicit deadline budget.
2. A stalled or runaway query terminates predictably rather than consuming a worker process until external platform timeouts.
3. Database calls are traced by route, making slow or chatty endpoints visible on real-time dashboards.
4. Latency, errors, and database-call counts are continuously monitored with zero private data leakage.

---

## 1. Timeout Hierarchy & Database Safeguards

| Parameter | Default Bound | Scope | Purpose |
|---|---|---|---|
| `statement_timeout` | **2,500ms** (routes) / **5,000ms** (database) | Per SQL query | Aborts queries that stall or scan unbounded rows. |
| `lock_timeout` | **1,500ms** – **2,000ms** | Lock acquisition | Prevents transaction pileups waiting on locked rows. |
| `idle_in_transaction_session_timeout` | **3,000ms** – **5,000ms** | Open transaction | Terminates orphaned connections holding open transactions. |
| `request_deadline` | **2,500ms** – **6,000ms** | End-to-end request | Terminates pending database work if request deadline has elapsed. |

### PostgreSQL Database Procedures (Migration `0021`)
- `public.set_session_deadlines(p_statement_timeout_ms, p_lock_timeout_ms, p_idle_timeout_ms)`: Dynamically sets session/transaction bounds clamped safely between 500ms and 30,000ms.
- `public.record_database_trace(...)`: Atomically writes route telemetry with strict internal statement timeouts.
- `public.prune_database_query_traces(p_retention_days)`: Maintains bounded storage growth.

---

## 2. Route Query Budgets

Each route has an explicit query budget configured in `lib/supabase/queryBudget.ts`:

| Route | Max Queries | Target Duration (p95) | Statement Timeout | Request Deadline | Flagged Behavior |
|---|---|---|---|---|---|
| `/api/trips` | **3** | 1,500ms | 2,000ms | 3,000ms | Chatty if > 3 queries |
| `/api/expenses` | **4** | 2,000ms | 2,500ms | 4,000ms | Chatty if > 4 queries |
| `/api/settlement` | **6** | 3,000ms | 3,000ms | 5,000ms | Slow if > 3,000ms |
| `/api/auth` | **3** | 1,000ms | 1,000ms | 2,500ms | Strict auth guard |
| `/api/export` | **8** | 4,000ms | 3,500ms | 6,000ms | Paginated bulk reads |
| `default` | **8** | 3,000ms | 2,500ms | 5,000ms | General route budget |

---

## 3. Propagated Deadlines Across Requests

Clients and internal proxies can propagate request deadlines and correlation identifiers via standard HTTP headers:
- `x-request-deadline`: ISO 8601 timestamp or epoch milliseconds when the request expires.
- `x-request-timeout-ms`: Milliseconds budget allocated to the request.
- `x-request-id`: Distributed correlation ID matching error reports and query traces.

If the deadline expires before a query starts or while executing, `runWithQueryBudget` aborts the call predictably and throws `QueryDeadlineExceededError` or `QueryTimeoutError` with stable codes:
- `DATABASE_DEADLINE_EXCEEDED`
- `DATABASE_QUERY_TIMEOUT`
- `QUERY_COUNT_BUDGET_EXCEEDED`

Responses return performance metadata:
- `X-Database-Queries`: Total queries executed during the request.
- `X-Database-Duration-Ms`: Cumulative query duration in milliseconds.
- `X-Database-Deadline-Remaining-Ms`: Remaining deadline budget.
- `X-Database-Status`: Health status (`ok`, `slow`, `chatty`, `deadline_exceeded`).

---

## 4. Query Observability & Dashboard

The Analytics Dashboard (`components/analytics/AnalyticsDashboard.tsx` & `DatabaseBudgetsPanel.tsx`) provides:
1. **Key Performance Indicators**:
   - Average and p95 query latency across all routes.
   - Total database calls and distinct API requests.
   - Stalled queries aborted predictably before platform worker timeouts.
   - Query failures and overall error rates.
2. **Route Performance Matrix**:
   - Compares actual queries per request against route limits (identifying chatty endpoints).
   - Compares p95 latency against duration limits (identifying slow endpoints).
   - Displays statement and lock timeout budgets.
3. **Interactive Simulation Tool**:
   - Operators can simulate fast, slow, chatty, or stalled queries to test predictable cancellation and observe instant metric updates.
4. **Recent Query Traces**:
   - Filterable ring buffer of the latest database queries with duration, row count, status, and request correlation IDs.
   - Strict redaction invariant: zero raw SQL parameters, Stellar secrets, or JWT tokens are retained in telemetry.

---

## 5. Rollback Procedures

If Migration 0021 must be reverted:
```sql
DROP TABLE IF EXISTS public.database_query_traces CASCADE;
DROP FUNCTION IF EXISTS public.record_database_trace(TEXT, TEXT, TEXT, TEXT, NUMERIC, INT, INT, TEXT, TEXT);
DROP FUNCTION IF EXISTS public.set_session_deadlines(INT, INT, INT);
DROP FUNCTION IF EXISTS public.prune_database_query_traces(INT);
DELETE FROM public.schema_migrations WHERE version = '0021';
```

## 6. Query Plan Fixtures

```sql
-- Route filter query plan
EXPLAIN ANALYZE SELECT * FROM public.database_query_traces
WHERE route = '/api/trips' ORDER BY created_at DESC LIMIT 50;
-- Plan: Index Scan using idx_database_query_traces_route_created (cost=0.15..8.20 rows=50 width=128)

-- Health status filter query plan
EXPLAIN ANALYZE SELECT * FROM public.database_query_traces
WHERE status IN ('slow', 'chatty', 'timeout') ORDER BY created_at DESC LIMIT 50;
-- Plan: Index Scan using idx_database_query_traces_status_created (cost=0.15..12.35 rows=50 width=128)
```
