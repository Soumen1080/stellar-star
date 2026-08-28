# Design Note — FX Rate Service (Seam S4)

## Problem

Nobody prices a dinner in XLM. Until a user can type "1200 INR", Stellar-Star
is a crypto demo rather than an expense app. That needs an exchange rate, and a
rate is a claim about the world that can be wrong, stale, manipulated, or
unavailable.

This document describes the system that issues #160 adds to close seam S4.

---

## Invariants

These are not aspirations — they are enforced by the implementation and tested
by `__tests__/fx/`.

| # | Invariant |
|---|-----------|
| 1 | Rate unavailability **never blocks expense creation**. Degraded path is designed state, not an error branch. |
| 2 | A stale value is served **only when explicitly marked** stale, with its age. Never silently. |
| 3 | N concurrent identical requests produce **at most one upstream call**. |
| 4 | A failing provider is bypassed **without repeatedly paying its timeout**. |
| 5 | No credential ever reaches the client bundle. |
| 6 | Every quote carries **provenance**: `source` + `fetchedAt`. |

---

## Architecture

```
User types "1200 INR"
        │
        ▼
hooks/useFxRate.ts          ← client-side deduplication (module-level in-flight map)
        │
        ▼  HTTP GET /api/fx/rate?from=INR&to=XLM
        │
app/api/fx/rate/route.ts    ← server-only; no credentials leak here
        │
lib/fx/rateService.ts       ← S4 seam: orchestration, never throws
        │
   ┌────┴──────────────────────────────────────────────────┐
   │ Provider chain                                         │
   │                                                       │
   │  1. CoinGeckoProvider    → XLM/fiat live prices       │
   │     CircuitBreaker(coingecko)                         │
   │                                                       │
   │  2. ExchangeRateProvider → fiat/USD + XLM/USD bridge  │
   │     CircuitBreaker(exchangerate-host)                  │
   └────────────────────────────────────────────────────────┘
        │
lib/fx/rateCache.ts         ← two-level cache + stampede protection
```

---

## Provider chain

Two off-chain REST providers are used. Neither queries the Stellar DEX.

### CoinGeckoProvider (`lib/fx/providers/coingecko.ts`)

- Source: `https://api.coingecko.com/api/v3/simple/price`
- Pairs: anything where one side is XLM (`XLM → FIAT` or `FIAT → XLM`).
- For `FIAT → XLM`: fetches XLM/FIAT, inverts.
- Credentials: optional `COINGECKO_API_KEY` server env var (no `NEXT_PUBLIC_`).

### ExchangeRateProvider (`lib/fx/providers/exchangerate.ts`)

- Source: `https://api.exchangerate.host`
- Pairs: `FIAT → FIAT` directly; `FIAT ↔ XLM` via USD bridge.
- No credentials required for the free tier.
- USD bridge: `FIAT → XLM = (FIAT/USD) / (XLM/USD)`.

---

## Freshness policy

Fiat/USD rates are published at most daily (ECB, central bank sources). XLM
moves by the second. One TTL for both is wrong in one direction or the other.

| Pair type | TTL | Max stale |
|-----------|-----|-----------|
| Crypto (one side XLM) | 60 s | 300 s |
| Fiat/fiat | 3 600 s | 86 400 s |

---

## Cache design

`lib/fx/rateCache.ts` implements a two-level in-process cache:

- **Fresh tier** (age < TTL): returned immediately, no upstream call.
- **Stale tier** (TTL ≤ age < maxStale): returned with `stale: true` and `rateAgeMs`.
- **Expired** (age ≥ maxStale): evicted; treated as a miss.

### Stampede protection

In-flight `Promise`s are stored in a `Map<pair, Promise>`. A second request for
the same pair joins the existing promise rather than starting a new upstream
fetch. The promise is removed from the map on settlement so the next request
after a failure starts fresh.

---

## Circuit breaker

`lib/fx/circuitBreaker.ts` wraps each provider independently.

```
          failure × N
CLOSED ──────────────► OPEN ──── resetTimeout ──► HALF_OPEN
  ▲                                                    │
  │    probe success                     probe success │
  └────────────────────────────────────────────────────┘
                              │ probe failure
                              ▼
                             OPEN
```

Defaults:
- `failureThreshold`: 3 consecutive failures → OPEN.
- `resetTimeoutMs`: 30 s OPEN before moving to HALF_OPEN.

The two breakers (one per provider) are independent: a flapping CoinGecko does
not affect the ExchangeRate breaker.

---

## Testnet / mainnet parity

Both providers are off-chain REST APIs. They return real market prices
regardless of which Stellar network the app is connected to. There is no
`if (STELLAR_NETWORK === "TESTNET")` branch and no mock data path that could
hide a production bug.

---

## Degraded path (invariant 1)

If every provider is down and the cache has no usable entry:

```json
{
  "rate": null,
  "source": null,
  "fetchedAt": null,
  "stale": false,
  "rateAgeMs": null,
  "unavailable": true
}
```

The API route returns HTTP **200** with this body. The client receives a
structured `unavailable: true` flag rather than a network error. The UI shows a
warning ("Rate unavailable — enter amount in XLM manually") but does not block
form submission. A rate service outage does not take the app down.

---

## What this seam explicitly does not cover

- On-chain DEX pricing. Book-thinness and manipulation apply there; this design
  avoids that entirely.
- Cross-rate arbitrage detection (whether CoinGecko and ExchangeRate disagree).
- Persistent (Redis / Supabase) cache across processes. The cache is
  in-process. A multi-instance deployment each has its own warm-up period and
  its own breaker state. This matches the existing pattern for the attestation
  oracle and sponsorship ledger.
- Multi-hop fiat conversion (e.g. INR → EUR → XLM). The USD bridge covers all
  pairs ExchangeRate.host knows; gaps fall through to `unavailable`.

---

## File index

| File | Role |
|------|------|
| `lib/fx/types.ts` | Shared types: `RateResult`, `FxProvider`, `CacheEntry`, etc. |
| `lib/fx/circuitBreaker.ts` | Per-provider circuit breaker |
| `lib/fx/rateCache.ts` | Two-level cache + stampede protection |
| `lib/fx/providers/coingecko.ts` | CoinGecko provider |
| `lib/fx/providers/exchangerate.ts` | ExchangeRate.host provider |
| `lib/fx/rateService.ts` | S4 seam orchestrator (singleton `defaultRateService`) |
| `app/api/fx/rate/route.ts` | `GET /api/fx/rate?from=&to=` |
| `hooks/useFxRate.ts` | Browser-side hook |
| `__tests__/fx/circuitBreaker.test.ts` | Breaker state machine tests |
| `__tests__/fx/rateCache.test.ts` | Cache tier + stampede tests |
| `__tests__/fx/providers.test.ts` | Provider isolation tests |
| `__tests__/fx/rateService.test.ts` | End-to-end service tests |
