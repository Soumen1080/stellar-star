# Design Note: Exactly-Once Settlement Recording Under Concurrency and Crashes

Issue #156 (epic #50).

## The problem

Settlement in Stellar-star spans four systems that can each fail independently:
1. **Horizon** (the Stellar value transfer on ledger)
2. **Soroban** (the smart contract audit record via `record_payment`)
3. **Supabase** (Postgres application state in `expenses.shares` and `trips`)
4. **Client State** (in-flight React state and browser storage)

In the original flow, the client submitted to Horizon, then requested an oracle attestation, then recorded on Soroban, then updated Supabase — with an ephemeral `localStorage` retry record attempting to paper over failure gaps.

Every seam was a lost-money window:
- **Crash after Horizon submit**: If the user's browser closed between Horizon submission and the Supabase write, the payment occurred on the ledger, but the app never knew. The debtor's money was gone and the debt remained open.
- **Concurrent Settlement on the Same Debt**: If two tabs or clients attempted to settle the same share simultaneously, both could submit Stellar transactions, producing a double-payment.
- **Concurrent JSONB Writes**: When two members settled different shares of the same expense concurrently, `markSharePaidRow` executed a read-modify-write on the JSONB `shares` column. Because read and write were not atomic, whichever write landed second silently overwrote and erased the first member's paid status (lost update anomaly).
- **Device-Bound Retry**: `lib/utils/pendingOnChain.ts` stored retries in browser `localStorage`. Clearing site data or opening the app on a mobile device destroyed all recovery information.

## The approach taken

There is no distributed transaction available across Horizon, Soroban, and Postgres. Therefore, settlement cannot be made atomic; it must be made **convergent**: every partial failure must be detectable and recoverable by any client on any device.

### 1. Durable Intent Store Before Irreversible Action

Before building or submitting any transaction to Horizon, the client records an intent in `public.settlement_intents` in Supabase with `status = 'submitting'`.
- The intent carries a deterministic idempotency key (`settle:tripId:expenseId:memberId`).
- An active intent (unexpired, status `submitting` or `submitted`) locks out concurrent settlement attempts on the same share (Invariant 3).
- Immediately upon receiving transaction confirmation from Horizon, the client updates the intent with `tx_hash` and `status = 'submitted'`. From this moment forward, the fact that money moved is durably recorded in Postgres and queryable by all participants.

### 2. Pessimistic Row-Level Locking on Postgres JSONB Updates

To prevent lost updates under concurrent settlement writes to the `expenses.shares` JSONB column, we implemented the `public.mark_share_paid` and `public.mark_shares_paid_batch` PostgreSQL stored procedures in `supabase-setup.sql`.

```sql
SELECT * INTO v_row
  FROM public.expenses
 WHERE id = p_expense_id
   FOR UPDATE;
```

`SELECT ... FOR UPDATE` acquires an exclusive row lock on the specific expense row for the duration of the transaction.
- When Member A and Member B settle different shares of the same expense concurrently, Postgres serializes their updates.
- Member B's transaction waits for Member A's update to commit, then transforms the already-updated `shares` array. Both shares are marked paid, and neither update is lost (Invariant 4).
- If the stored procedure is unavailable, the client query layer degrades to an optimistic retry loop.

### 3. Chain-Authoritative Reconciliation Engine

When Supabase state and the blockchain disagree, **the chain is strictly authoritative**.

`lib/settlement/reconcile.ts` implements two idempotent reconciliation paths:
1. **Intent Reconciliation (`reconcileSettlementIntent`)**: Looks up in-flight intents in Supabase. If `tx_hash` exists, it verifies the transaction directly on Horizon (`verifyPaymentByHash`). If Horizon confirms the payment succeeded, it obtains an attestation, completes the Soroban contract recording, marks the share paid in Supabase, and updates intent status to `'recorded'`.
2. **Chain-State Reconciliation (`reconcileTripWithChainState`)**: When contract payment events are fetched (`useContractEvents` / `get_payments`), any share in Supabase that is `paid: false` but has a confirmed on-chain event is automatically updated to `paid: true`.

Even if the paying browser is destroyed the millisecond after Horizon accepts the transaction, when another member opens the trip on a fresh device, reconciliation converges the app state to match the blockchain (Invariant 1 & 5).

### 4. Device-Agnostic Recovery (No localStorage Prerequisite)

Pending retries and in-flight settlements are stored in `settlement_intents` in Supabase and queried on mount. A user logging in on a brand-new phone or browser converges to the correct state without relying on local storage (Invariant 5). `localStorage` is retained only as an auxiliary cache for offline degraded scenarios.

### 5. Idempotency

Reconciliation is completely idempotent:
- Invoking `mark_share_paid` on an already-paid share is a safe no-op.
- Running `reconcileSettlementIntent` or `reconcileTripWithChainState` repeatedly produces identical state with zero duplicate transfers or side-effects (Invariant 6).

## Alternatives considered and rejected

### Alternative A: Two-Phase Commit (2PC) / Sagas across Horizon and Postgres
Attempting a distributed 2PC or Saga orchestrator between the client, Horizon, and Postgres.
- **Why rejected**: Stellar Horizon and Soroban do not support distributed transaction coordinators or arbitrary rollbacks. Once an XLM payment ledger transaction is confirmed, it is immutable and irreversible. Designing for rollbacks is impossible; the system must design for forward-recovery and reconciliation instead.

### Alternative B: Pure Client-Side Optimistic Concurrency on JSONB (CAS Loops)
Using a version column on `expenses` and having clients perform read-compare-and-swap loops when writing JSONB `shares`.
- **Why rejected**: Under high contention (e.g., several trip members settling at the end of a trip), client-side CAS loops suffer from high abort rates, latency spikes, and network retry overhead. Furthermore, if a client crashes mid-CAS loop, the write is abandoned. Postgres row-level locking (`SELECT ... FOR UPDATE`) in a database function provides guaranteed atomic serialization in a single round-trip.

### Alternative C: Relying on Browser localStorage for Retry State
Keeping retry records in `localStorage` and polling on page reload.
- **Why rejected**: Directly violates Invariant 5. If a user switches devices, opens private browsing, or clears cookies/site data, all knowledge of the in-flight payment is lost. Storing durable intent in Supabase ensures any client observing the trip can recover the payment.

## Invariant Verification

| Invariant | Mechanism |
|---|---|
| **1. Eventual Reflection** | `reconcileSettlementIntent` and `reconcileTripWithChainState` discover confirmed Horizon/Soroban transactions and heal Supabase shares regardless of client origin. |
| **2. No Double-Payment** | Intent with `tx_hash` is checked against Horizon before initiating any new transfer; if payment already exists, the existing transfer is reconciled. |
| **3. Concurrent Settlement Exclusion** | `acquireSettlementIntent` enforces uniqueness on active intents for `(expense_id, member_id)`, blocking concurrent payment attempts. |
| **4. No Lost Updates** | `mark_share_paid` stored procedure uses `SELECT ... FOR UPDATE` to serialize concurrent JSONB array updates. |
| **5. Device-Agnostic Recovery** | In-flight state lives in Supabase `settlement_intents` and Horizon/Soroban ledgers; zero dependency on `localStorage`. |
| **6. Idempotent Reconciliation** | Multiple executions of reconciliation functions produce the exact same final state. |

## Residual Weaknesses, Stated Plainly

- **Stellar Horizon Eventual Consistency**: Horizon ingestion can lag ledger close by 1-2 seconds. During this brief window, `verifyPaymentByHash` may return a transient 404, prompting a retryable delay before reconciliation completes.
- **Intent Expiry Window**: An abandoned wallet signature prompt holds an intent lock until its 15-minute expiration time elapses or the user explicitly cancels.

## Test Coverage

- `__tests__/settlement/exactlyOnce.test.ts`:
  - Crash simulation before Horizon submit (clean expiry, safe retry).
  - Crash simulation immediately after Horizon submit (durable intent with `tx_hash` recovered and reconciled from fresh device).
  - Crash simulation after Soroban contract record before Supabase write (reconciliation from on-chain events heals Supabase).
  - Concurrency exclusion on identical share (second payment blocked).
  - Concurrent writes on distinct shares of same expense (no lost updates).
  - Idempotent repeated reconciliation.
- `__tests__/payment/usePayment.concurrency.test.tsx`:
  - Hook-level pre-flight intent locking and device-agnostic recovery tests.
