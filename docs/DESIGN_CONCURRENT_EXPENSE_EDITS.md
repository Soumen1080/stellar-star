# Design Note: Concurrent Expense Editing and Safe Conflict Resolution

Issue #157 (epic #51).

## The problem

In Stellar-star, `expenses.members` and `expenses.shares` are stored as JSONB blobs. Any trip member with appropriate RLS permissions can edit an expense. Furthermore, `lib/supabase/useRealtimeCollection.ts` subscribes to `postgres_changes` and replaces local state with whatever arrives over the websocket.

This created a severe lost-update problem under concurrent editing:
- **Last-Write-Wins Over Blobs**: If Member A added a new participant while Member B corrected the total amount or changed split weights, whichever write landed last in Postgres silently overwrote and erased the other edit with zero error, zero conflict indication, and zero recovery mechanism.
- **Coupled Financial Invariants**: `members`, `shares`, and `total_amount` cannot be merged naively. Changing `members` requires recalculating `shares`, and changing `total_amount` requires recalculating `shares`. A simple field-level merge can produce an internally corrupt expense where `sum(shares) != totalAmount`.
- **Settled Money Boundary**: Once money moves on Stellar, a share with `paid: true` and `txHash` represents irreversible financial ledger truth. A merge must never recompute or modify a settled share.
- **Realtime Echoes & Out-of-Order Delivery**: Realtime websocket messages arrive asynchronously relative to optimistic client writes. Stale out-of-order events could overwrite newer local states, or self-echoes could cause UI flickering.

## The approach taken

We implemented **Optimistic Concurrency Control (OCC)** coupled with a **Deterministic 3-Way Financial Merge Engine** and a **Monotonic Realtime Event Filter**.

```
          [Base Expense v1]
           /              \
[Client Proposed Edit]   [Server State v2 (Concurrent Edit)]
           \              /
     [3-Way Merge Engine (conflictResolver.ts)]
                  |
     +------------+------------+
     |                         |
[Orthogonal Merge]      [Conflicting Edit]
Recompute unpaid shares Reject with ExpenseConflictError
Preserve settled shares Prompt user with server state
Update to v3
```

### 1. Monotonic Versioning on Expenses

In `supabase-setup.sql` and `types/supabase.ts`, we added an integer `version` column (default `1`) to `public.expenses`.
Every write operation (whether direct update or RPC `update_expense_versioned`) increments `version = version + 1`.

When a client submits an edit, it supplies the `baseExpense` (including `baseExpense.version`) that was present when the user began editing.

### 2. Coupled 3-Way Merge Engine (`lib/expense/conflictResolver.ts`)

When a client's edit encounters a version mismatch (`serverExpense.version > baseExpense.version`), the system invokes `mergeExpenseUpdates(baseExpense, serverExpense, proposedUpdates)`:

1. **Orthogonal Field Merges (Automatic)**:
   - If Client modified metadata (e.g. `title`, `description`) while Server modified `totalAmount`, both edits apply.
   - If Client added Member C while Server modified `title`, Member C is added to Server's member list.
2. **Conflicting Field Collision (Explicit Rejection)**:
   - If Client and Server both modified the *same* scalar field to different values (e.g., both changed `totalAmount` or `title` to different values), the edit is **rejected** with `ExpenseConflictError`.
   - Invariant 1 is satisfied: No committed edit is silently discarded; the user is told why the edit could not apply and is provided the server's current state.

### 3. Settled Share Immutability & Exact-Sum Re-apportionment

To satisfy Invariants 2 & 3 during an edit or merge:
1. `recomputeSharesWithSettled` extracts all settled shares (`paid: true`, `txHash`).
2. Settled shares are **strictly immutable**: their amounts and paid statuses are untouched.
3. The total settled amount is calculated: $S_{paid} = \sum_{s \in settled} s.amount$.
4. If the new total amount $T < S_{paid}$, the edit is rejected because an expense cannot be reduced below what was already paid on-chain.
5. The remaining unpaid balance $T_{unpaid} = T - S_{paid}$ is re-apportioned among the remaining *unpaid* members according to `splitMode` (equal or custom weights).
6. Total post-merge sum is $S_{paid} + T_{unpaid} = T$, mathematically guaranteeing `sum(shares) == total`.

### 4. Realtime Monotonicity and Echo Suppression (`useRealtimeCollection.ts`)

In `useRealtimeCollection.ts`, `applyUpsert` compares incoming event versions against local state:
- If `incoming.version < existing.version`: The event is stale (out-of-order network delivery) and is **discarded**.
- If `incoming.version === existing.version`: The event is a duplicate or self-echo and is **suppressed** to prevent state churn and UI flickering.
- If `incoming.version > existing.version`: The event is applied monotonically.

## Alternatives considered and rejected

### Alternative A: Full CRDTs (Conflict-Free Replicated Data Types)
Using JSON CRDTs (e.g., Automerge or Yjs) for the entire expense row.
- **Why rejected**: CRDTs excel at text documents and independent registers, but struggle with rigid financial invariants such as $\sum shares == total$ and settled share immutability. An arbitrary LWW or multi-value register merge in CRDTs can easily produce invalid split sums or resurrect deleted shares. The domain requires semantic 3-way financial reconciliation rather than syntax-level CRDT convergence.

### Alternative B: Operational Transformation (OT)
Streaming fine-grained change operations over WebSockets to a central transform server.
- **Why rejected**: Requires a specialized stateful server cluster running dedicated transformation loops for every active document. Supabase provides PostgreSQL + Realtime events over HTTP/WebSocket, making OCC + 3-way merge significantly simpler, stateless, and verifiable within standard database constraints.

### Alternative C: Pessimistic Row / Editing Locks
Locking an expense row whenever a user opens the "Edit Expense" modal, preventing any other user from opening or editing it.
- **Why rejected**: Highly fragile in web applications. If a user closes the browser tab, loses cellular connectivity, or walks away with the edit modal open, the expense remains locked indefinitely for all other trip participants. Optimistic concurrency allows collaborative editing with graceful merge and conflict detection.

## Invariant Verification

| Invariant | Mechanism |
|---|---|
| **1. No Silently Discarded Edits** | OCC version checks detect collisions. Clean edits auto-merge; conflicting edits throw `ExpenseConflictError`. |
| **2. Settled Share Immutability** | `recomputeSharesWithSettled` locks settled shares as read-only; attempts to remove settled members or reduce totals below $S_{paid}$ are rejected. |
| **3. Exact Sum Conservation** | Unpaid balance $T_{unpaid} = T - S_{paid}$ is precisely calculated and apportioned so $\sum shares = T$. |
| **4. Valid Server States Only** | Merged states are verified and written atomically via Postgres transactions/RPC. |
| **5. Monotonic Convergence** | Realtime listener drops stale out-of-order deliveries and enforces strict version monotonicity. |

## Residual Weaknesses, Stated Plainly

- **Simultaneous Direct Collisions**: If two users simultaneously edit the same description or amount to different values, the second user must review the conflict prompt and re-apply their desired changes.

## Test Coverage

- `__tests__/expense/conflictResolver.test.ts`:
  - Concurrent non-conflicting edits (Member added + Amount changed -> Auto-merged cleanly with `sum(shares) == total`).
  - Conflicting scalar edits (Both change amount -> Rejected with `ExpenseConflictError`).
  - Settled share protection (Attempting to modify settled shares or reduce total below settled amount is blocked).
  - Split re-apportionment across equal and custom split modes.
- `__tests__/supabase/useRealtimeCollection.monotonic.test.tsx`:
  - Stale out-of-order event rejection.
  - Self-echo deduplication without state churn.
  - Monotonic version progression.
