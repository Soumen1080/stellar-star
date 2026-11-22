# Leased reconciliation queue (#416)

Settlement reconciliation calls Horizon and Soroban RPC. Before this change
those calls ran inside whichever HTTP request started a worker pass. Two
overlapping passes read the same due rows, so a payment could be reconciled
twice. A pass killed by the platform timeout left work half done, and nothing
recorded that it had been interrupted.

Reconciliation now runs on a leased work queue in
`public.reconciliation_queue` (migration `0026_reconciliation_leased_queue`).

## How it works

| Step | Where | Guarantee |
| --- | --- | --- |
| Enqueue | `enqueue_reconciliation_job()`, `enqueueReconciliationJob()` | At most one job per dedupe key (`intent:<id>`, or `tx:<hash>:<expense>:<member>`). The table is range-partitioned by `created_at`, so a global unique index is not possible. The function takes a transaction-scoped advisory lock on the key instead. `SECURITY INVOKER`: a wallet session can enqueue only jobs it is a party to (RLS). No network call. |
| Claim | `claim_reconciliation_jobs()` | `FOR UPDATE SKIP LOCKED` over the partial index `idx_reconciliation_queue_claimable`. Each claimed job gets a fresh `lease_token`, a `lease_owner` and a `lease_expires_at`. Concurrent workers never receive the same job. |
| Heartbeat | `heartbeat_reconciliation_job()`, `ReconciliationLease` | The worker extends its lease every 30 s (lease 90 s). It re-confirms the lease before every side effect outside the row (contract write, share and intent updates). |
| Transition | `updateReconciliationJobRow(…, lease)` | Fenced on `(id, lease_token)`; also hands the lease back. If the lease was re-claimed, the write matches nothing and `ReconciliationLeaseLostError` is thrown. A stale worker cannot overwrite the new owner's progress. |
| Failure | `fail_reconciliation_job()` | Counts an attempt and schedules exponential backoff with jitter. At `max_attempts` the job moves to `dead_letter`. Only a stable error code is stored, never error text. |
| Crash | `claim_reconciliation_jobs()` | An expired lease makes the job claimable again (`lease_recoveries` + 1). After `max_lease_recoveries` (3) expiries the job is dead-lettered as `LEASE_EXPIRED_REPEATEDLY`, so a poison job cannot keep killing workers. |
| Deadline | `runReconciliationWorker({ deadline })` | A run stops starting jobs at its time budget (45 s, below the route's 60 s `maxDuration`) and releases the claims it has not started. Releasing does not consume an attempt. |
| Requeue | `requeue_reconciliation_job()` | Staff only. Returns a dead-lettered job to the state it was dead-lettered from, with its attempts reset. |

Worker RPCs are `SECURITY DEFINER` and executable by `service_role` only.
Wallet sessions keep `SELECT` and `INSERT` on their own rows but no longer have
`UPDATE`. A lease is only meaningful if no party can rewrite it.

## HTTP surface

- `GET /api/settlement/reconciliation-worker/cron` is the scheduled worker
  (cron secret). It runs one bounded pass of leased batches.
- `POST /api/settlement/reconciliation-worker` (cron or staff):
  - `{ "action": "run" }` (default) runs one bounded, leased pass.
  - `{ "action": "enqueue" }` syncs pending settlement intents into the queue
    and returns `202`. It makes no Horizon or RPC call.
  - `{ "action": "requeue", "jobId": "<uuid>" }` requeues a dead-lettered job
    (`202`), or returns `409` if the job is not dead-lettered.
- `POST /api/settlement/reconcile`: when Horizon is unreachable or slow, a
  signed-in party who supplied `payerWallet`, `memberWallet` and `amount`
  gets `202 { queued: true, jobId }`. The payment is no longer dropped with a
  503. A retry returns the same job. Anonymous callers still get `503`.

## Operating it

- **Backlog**: the dashboard's pending counts and the `HIGH_PENDING_QUEUE` /
  `PENDING_AGING_EXCEEDED` alerts. Throughput scales with concurrent workers,
  because claims never contend (SKIP LOCKED).
- **Dead letters**: the `DEAD_LETTERED_JOBS` alert (critical), the
  `dead_letter` filter on the dashboard, and the job's `dead_letter_reason`.
  Fix the cause, then use **Requeue** on the dashboard, or POST
  `{ "action": "requeue", "jobId" }`.
- **Stuck lease**: a job whose `lease_expires_at` is in the past is
  recovered by the next claim automatically. No manual action is needed.
- **Run log**: `reconciliation_worker_runs` now also records `worker_id`
  (the lease owner of the run's claims), `dead_lettered` and `lease_lost`.

## Evidence

- `__tests__/settlement/reconciliationLeasedQueue.test.ts`:
  - concurrency: two workers draining one queue never reconcile the same job;
  - lease recovery and fencing of a dead worker's late write;
  - heartbeats holding a lease past its nominal expiry;
  - retry, then dead letter, then requeue; poison jobs; deadline release;
  - a 1,000-job backlog drained by 4 workers, exactly once per job, with
    the measured throughput logged.
- `__tests__/settlement/reconciliationQueueRoutes.test.ts` covers the HTTP
  enqueue, requeue and Horizon-outage paths.
- `__tests__/database/fixtures/reconciliationQueuePlan.fixture.json` holds
  PostgreSQL 16 plans for claim, lease sweep, dedupe and dead-letter listing,
  captured on 200,000 rows. It also records the concurrency measurements
  from parallel `psql` sessions: two overlapping claimers got disjoint sets,
  8 parallel workers produced 0 duplicate claims, and 6 concurrent enqueues of
  one key created 1 row.

## Rollback

See the header of `migrations/0026_reconciliation_leased_queue.sql`. Stop the
cron route, drop the six functions, map `dead_letter` rows back to
`dead_lettered_from`, and restore the 0021 status check.
