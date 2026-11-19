# Stellar Circuit Breakers & Concurrency Bulkheads

This document describes the architecture, concurrency bulkheads, circuit breakers, timeout budgets, and fault isolation mechanisms for Stellar providers (Horizon & Soroban RPC) in Stellar-star (#426 / Issue 018).

---

## 1. Problem Statement: Cascading Worker Starvation

Stellar-star relies on external network endpoints for ledger queries, transaction submissions, and smart contract verification:
- **Horizon**: Account balances, ledger sequence, fee stats, operation lookups.
- **Soroban RPC**: Smart contract simulation, event logs, transaction confirmations.
- **Attestation Oracle**: Cryptographic payment attestation verification.

### The Unconstrained Retry Hazard

When upstream Stellar nodes or RPC providers experience degraded performance (e.g. latency spikes from 100ms to 30,000ms, intermittent 502/503/504 errors, or connection hangs):
1. **Request Worker Exhaustion**: Incoming web requests block waiting on slow upstream calls. Under standard concurrency limits, all Node.js request workers become tied up waiting on stalled sockets.
2. **Cascading Starvation**: Unrelated endpoints (such as viewing trips, reading cached expenses, editing member preferences, or generating offline receipts) cannot obtain an execution thread and fail with timeouts, even though their own dependencies (Supabase, local database) are 100% healthy.
3. **Thundering Herds**: Unconstrained client or server retry loops hammer the already-struggling provider, exacerbating the outage.

---

## 2. Architectural Solution

Stellar-star implements a layered defense-in-depth resilience pattern:

```
┌────────────────────────────────────────────────────────┐
│                   Incoming Request                     │
└───────────────────────────┬────────────────────────────┘
                            │
               ┌────────────▼────────────┐
               │    Bulkhead Pool        │  (Limits max concurrent calls
               │ (Per Dependency Class)  │   & queues per provider class)
               └────────────┬────────────┘
                            │
               ┌────────────▼────────────┐
               │     Circuit Breaker     │  (Fails fast in <1ms if OPEN;
               │ (Per Dependency Class)  │   probes in HALF_OPEN)
               └────────────┬────────────┘
                            │
               ┌────────────▼────────────┐
               │  Short Timeout Guard    │  (Aborts hung calls at
               │    (AbortController)    │   3s - 10s budget)
               └────────────┬────────────┘
                            │
               ┌────────────▼────────────┐
               │ Bounded Jitter Retry    │  (Exponential backoff with
               │       Engine            │   ±20% randomized jitter)
               └────────────┬────────────┘
                            │
                            ▼
                  [External Provider]
```

---

## 3. Dependency Classes & Bulkhead Compartments

Rather than sharing a single global pool, concurrency budgets are partitioned into independent **bulkhead compartments**:

| Dependency Class | Scope / Operations | Max Concurrent | Max Queue | Timeout Budget |
|---|---|---|---|---|
| `horizon_read` | `getAccountState`, `getXLMBalance`, `fetchFeeStats`, ledger checks | 25 | 50 | 4,000 ms |
| `horizon_write` | `submitSignedTransaction` | 10 | 20 | 10,000 ms |
| `soroban_rpc` | `simulateTransaction`, `sendTransaction`, `getTransaction`, contract calls | 20 | 40 | 8,000 ms |
| `oracle_verify` | Server-side Horizon payment verification | 15 | 30 | 5,000 ms |

### Concurrency Isolation Guarantee
If `horizon_read` is completely saturated and rejecting calls, **its queue rejection has zero effect on `soroban_rpc` or internal database operations**. Unrelated operations proceed with full throughput and sub-millisecond dispatch.

---

## 4. Circuit Breakers: State Machine & Transition Rules

Each dependency class is governed by an independent `StellarCircuitBreaker`:

```
          ┌────────────────────────────────────────┐
          │                                        │
          ▼                                        │
     ┌─────────┐      failureCount >= threshold     │
     │ CLOSED  ├───────────────────────────────────►│
     └────▲────┘                                    │
          │                                         │
          │ canary success                          ▼
     ┌────┴─────┐      resetTimeout elapsed    ┌────────┐
     │ HALF_OPEN│◄─────────────────────────────┤  OPEN  │
     └────┬─────┘                              └────────┘
          │                                         ▲
          │ canary failure                          │
          └─────────────────────────────────────────┘
```

### 4.1 State Definitions
- **`CLOSED`**: Normal healthy operation. Calls are forwarded and raced against `callTimeoutMs`. Consecutive provider faults are tracked.
- **`OPEN`**: Provider degraded. Calls **fail fast immediately in < 1ms** with `StellarCircuitOpenError` (HTTP 503) without touching the network, preserving worker capacity.
- **`HALF_OPEN`**: Reset timeout has elapsed. A limited number of canary/probe requests are admitted to test if the provider has recovered.

### 4.2 Error Classification (Domain Safety)
The breaker strictly distinguishes between provider faults and client domain states:
- **Provider Faults** (trip breaker): 5xx HTTP errors, 429 rate limits, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`, call timeout expiry.
- **Domain States** (do NOT trip breaker): 404 on unfunded Stellar accounts, 400 transaction malformed, 401/403 auth errors.

---

## 5. Bounded Exponential Backoff with Jitter

When retries are attempted, the delay is calculated with bounded exponential backoff and randomized decorrelated jitter:

$$\text{delay} = \min\left(\text{maxDelayMs},\, \text{baseDelayMs} \times 2^{\text{attempt} - 1}\right) \times (1 \pm \text{jitterFactor})$$

- **Base delay**: 500 ms
- **Max delay**: 5,000 ms
- **Jitter factor**: $\pm 20\%$

If the circuit breaker opens during a retry loop, subsequent retries **abort immediately** without waiting through sleep delays.

---

## 6. Operational Telemetry & Health Endpoint

- **Endpoint**: `/api/developer/stellar-resilience`
- **Method `GET`**: Inspects breaker states (`CLOSED`, `OPEN`, `HALF_OPEN`), failure counts, active/queued bulkhead workers, and rejection counters.
- **Method `POST`**: Supports administrative reset of tripped breakers:
  ```json
  { "action": "reset" }
  ```

---

## 7. Fault Verification Evidence

The test suite in `__tests__/stellar/circuitBreakerBulkhead.test.ts` validates:
- **Fast Fail**: Open breakers reject in $<5$ ms.
- **Zero Starvation**: Saturated `horizon_read` pool does not affect concurrent `soroban_rpc` executions.
- **Self-Healing**: Breaker automatically recovers upon successful probe in `HALF_OPEN`.
- **404 Safety**: Unfunded account queries never increment failure counters.
