# Design Note: Correct and Complete On-Chain Reconciliation

## Context & Problem Definition

Stellar-star enables multi-party expense splitting and cryptographic settlement over the Stellar and Soroban networks. To confirm and display settlements on-chain, the frontend must reconcile on-chain ledger state with off-chain application records (in Supabase).

Previously, the app relied solely on polling `getEvents` from Soroban RPC with a 600-ledger (~1 hour) lookback. This had critical vulnerabilities:
1. **Key Collision & Lack of Asset Discrimination**: `buildPaymentEventKey` hardcoded `:native` and omitted the asset parameter. When multi-asset expenses or debts were introduced, a `10 USDC` payment and a `10 XLM` payment on the same expense shared the same key, causing false-positive settlement displays.
2. **Soroban RPC Event Retention Expiry**: Public Soroban RPC infrastructure retains contract events for a bounded window (typically ~24 hours). A 600-ledger lookback only covers ~1 hour. Once a trip was older than the retention window, RPC returned zero events, and the app lacked any other path to verify historical payments—leading users to believe their settlements were lost.
3. **Unconnected Contract State Path**: Although `get_payments(trip_id)` was implemented on the smart contract and wrapped by `getContractPayments`, it was never connected to the live reconciliation lifecycle.
4. **Unbounded Polling & Thundering Herd**: Polling every 10 seconds unconditionally per trip and immediately firing requests on every browser `visibilitychange` resulted in excessive RPC load.

---

## Reconciliation Architecture

```
                                  ┌──────────────────────────────┐
                                  │      Trip Reconciliation     │
                                  └──────────────┬───────────────┘
                                                 │
                        ┌────────────────────────┴────────────────────────┐
                        ▼                                                 ▼
        ┌──────────────────────────────┐                  ┌──────────────────────────────┐
        │     Durable Contract State   │                  │     Streaming Event Stream   │
        │   `getContractPayments()`    │                  │    `fetchContractEvents()`   │
        │  (Soroban persistent storage)│                  │     (Soroban RPC getEvents)  │
        └──────────────┬───────────────┘                  └──────────────┬───────────────┘
                       │                                                 │
                       │   Survives >24h retention window                │   Real-time low latency
                       │   Durable audit history                         │   Recent state transitions
                       │                                                 │
                       └────────────────────────┬────────────────────────┘
                                                │
                                                ▼
                               ┌────────────────────────────────┐
                               │     Deduplicated Union Map     │
                               │   Key: `buildPaymentEventKey`  │
                               │ (trip:exp:member:amount:asset) │
                               └────────────────┬───────────────┘
                                                │
                                                ▼
                               ┌────────────────────────────────┐
                               │   Exact Matching Engine &      │
                               │   Supabase State Convergence   │
                               │    (`markSharePaidRow`)        │
                               └────────────────────────────────┘
```

---

## Authority Rule for Disagreements

When on-chain contract state, RPC event notifications, and off-chain Supabase records disagree, the following deterministic authority rule applies:

1. **Contract Storage is Authoritative for Settlement Truth**:
   The smart contract's persistent storage (`get_payments` and `is_paid`) represents verified on-chain reality. A payment present in contract storage was authenticated by the Soroban VM (verifying oracle attestations, enforcing valid amounts and actors, and burning nonces). It is immutable and authoritative.
2. **Events Act as Streaming Notification Layer**:
   Contract events (`pmt_rec`) serve as a low-latency transport for notifying active clients of newly confirmed transactions.
3. **Deduplicated Union Merging**:
   The effective on-chain payment set is the deduplicated union of records obtained from contract storage and the event stream, indexed by `buildPaymentEventKey`.
   - If an event is pruned from RPC retention but exists in contract storage, it is reconciled as paid.
   - If an event has landed on-chain but is momentarily pending in a contract read simulation cache, the confirmed event is honored.
4. **Supabase is an Eventually Consistent Cache**:
   Database share states (`paid: boolean`, `tx_hash`) converge to match on-chain truth. When an on-chain record is confirmed, Supabase is updated via `markSharePaidRow`. Under no circumstances does a `paid: false` in Supabase override proof on the ledger.

---

## Invariants & Design Principles

### 1. Exact Matching on Five Dimensions
Matching between an expense share and an on-chain payment requires an exact 5-tuple match:
`Key = tripId:expenseId:debtorWallet_lowercase:amountStroops:canonicalAssetKey`

- Canonical assets are formatted as `"native"` for XLM or `"CODE:ISSUER"` for alphanumeric assets.
- Amounts are compared as integer stroops ($10^7$ subunits).
- Debtors are matched case-insensitively by Stellar public key (`G...`).
- Asset collisions (e.g., `10 USDC` vs `10 XLM`) produce distinct keys and never match each other.

### 2. Retention Window Expiry Resilience
Trips older than the Soroban RPC 24-hour retention window query contract storage via `getContractPayments` on initial load. This restores full settlement history regardless of when the trip was created.

### 3. Exhaustive Pagination
`fetchContractEvents` processes multi-page event streams using RPC cursors up to safety limits, ensuring high-volume trips never drop records past the 200-event page boundary.

### 4. Explicit Archival & TTL Handling
If contract storage has expired or archived, read simulation failures are caught and handled gracefully (`isArchived: true`), degrading cleanly to event logs and preventing uncaught UI exceptions.

### 5. Bounded Adaptive Polling
To protect RPC infrastructure and device battery:
- **Base Interval**: 10 seconds when active.
- **Adaptive Backoff**: Increases interval by 1.5x on consecutive idle polls up to a 60-second cap.
- **Backoff Reset**: Immediately resets to 10 seconds upon observing new events, user interaction, or manual refresh.
- **Throttled Visibility**: Tab focus / `visibilitychange` events are throttled to a minimum 5-second cooldown to prevent request bursts.
- **In-Flight Guard**: Overlapping concurrent network requests are deduplicated.
