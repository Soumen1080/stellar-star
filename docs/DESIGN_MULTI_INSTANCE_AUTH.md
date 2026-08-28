# Design Note: Multi-Instance Safe Wallet Authentication & Rate Limiting

Issue #158 (epic #52).

## The problem

In Stellar-star, wallet authentication works by issuing a challenge transaction containing a cryptographically random nonce in `/api/auth/challenge`, which the user signs in their Freighter wallet and submits to `/api/auth/verify` for signature validation and session token minting.

Previously, `lib/auth/challengeStore.ts` tracked issued nonces using an in-memory `Map` on `globalThis`. This suffered from critical vulnerabilities in multi-instance production environments (e.g. Vercel serverless, container clusters):

1. **Cross-Instance Replay & Misses**:
   - Instance A issues nonce $N$.
   - Instance B receives the `/api/auth/verify` request. Instance B has never seen nonce $N$ in its local process memory.
   - If not handled strictly, this caused broken logins or allowed challenges to be replayed across any instance that had not recorded the burn.
2. **Non-Atomic Consumption Race**:
   - Check-then-delete across distributed instances allowed two concurrent `/api/auth/verify` requests using the same signed transaction to both succeed (violating the single-use guarantee).
3. **Weaponized Eviction**:
   - The in-memory map had a global cap of 10,000 entries with FIFO eviction. An attacker could flood 10,000 challenge requests from their own script to flush and invalidate all legitimate pending challenges of other users.
4. **Unbounded Endpoint Abuse**:
   - Neither `/api/auth/challenge` nor `/api/auth/verify` had rate limiting.

## The approach taken

We implemented a **Multi-Instance Atomic Challenge Store** backed by PostgreSQL / Supabase, supplemented with **Isolated Per-Address Bucketing** and **Distributed Sliding-Window Rate Limiting**.

```
[Client / Freighter Wallet]
    |
    | 1. GET /api/auth/challenge (IP & Address Rate Checked)
    v
[Instance A] ---> RPC record_auth_challenge ---> [Supabase: auth_challenges]
                                                 (Per-address cap: max 5 active)
    |
    | 2. User signs transaction with nonce
    v
    | 3. POST /api/auth/verify (IP & Address Rate Checked)
    v
[Instance B] ---> RPC consume_auth_challenge ---> [Supabase: auth_challenges]
                  (Atomic DELETE WHERE nonce = N) (Row deleted: returns true exactly once)
    |
    +--> Mint Session JWT (sub = user.id)
```

### 1. Atomic Compare-and-Delete in Shared Store

When Supabase is configured, challenge lifecycle is backed by the `public.auth_challenges` table:
- `record_auth_challenge(address, nonce, expiration, max_pending)`: Cleans expired challenges for the address and bounds active pending challenges per address.
- `consume_auth_challenge(address, nonce, expiration, now)`:
  ```sql
  DELETE FROM public.auth_challenges
   WHERE nonce = p_nonce
     and address = p_address
     and expiration = p_expiration
     and expiration > p_now;
  ```
  Postgres executes the `DELETE` with immediate row locking. If two verify requests race on the same nonce, exactly one receives `row_count = 1` and succeeds; all concurrent requests receive `row_count = 0` and are rejected.

### 2. Eviction Isolation (Per-Address Bounds)

To prevent weaponized eviction (Invariant 3):
- Memory and database stores enforce **Per-Address Bucketing** rather than a single global FIFO queue.
- An address can hold at most `MAX_PENDING_PER_ADDRESS = 5` pending nonces.
- If an attacker generates 100,000 challenge requests for address $X$, it only rolls over address $X$'s own bucket. User $Y$'s pending challenges remain completely unaffected.

### 3. Distributed Sliding-Window Rate Limiting (`lib/auth/rateLimiter.ts`)

We added sliding-window rate limiting on both authentication endpoints:
- **`/api/auth/challenge`**: Max 30 requests/min per IP, max 10 requests/min per wallet address.
- **`/api/auth/verify`**: Max 20 requests/min per IP, max 10 requests/min per wallet address.
- Rate limits are stored in `public.auth_rate_limits` via atomic RPC (`check_auth_rate_limit`) with sliding-window calculations. Exceeded requests return `429 Too Many Requests` with a `Retry-After` header.

### 4. Explicit Store Failure Mode (Invariant 5)

If the database is configured but unreachable:
- Challenge consumption throws `AuthStoreError` with code `STORE_UNAVAILABLE`.
- `/api/auth/verify` returns an explicit `503 Service Unavailable` with `STORE_UNAVAILABLE`.
- Replay protection is **never silently downgraded or bypassed**.

## Alternatives considered and rejected

### Alternative A: Stateless JWT-Only Challenge Nonces
Encoding the nonce and expiration solely into a signed HMAC token without server-side storage.
- **Why rejected**: A pure stateless token can be submitted multiple times within its validity window (e.g. 5 minutes). Without an atomic distributed store to record consumption, replay attacks are trivial across all server instances.

### Alternative B: Direct Redis / Upstash Dependency
Requiring an external Redis instance for challenge storage and rate limiting.
- **Why rejected**: Stellar-star already uses PostgreSQL via Supabase. Introducing a mandatory secondary database dependency adds operational complexity, extra environment configurations, and another failure point. Postgres row-level locking provides atomic consumption and sliding-window rate limiting within the existing infrastructure.

### Alternative C: Global Cross-Instance Gossip / WebSocket Sync
Attempting to sync in-memory Maps between serverless instances using pub/sub.
- **Why rejected**: Serverless functions (e.g., Vercel Lambdas) freeze when idle and have transient lifecycles. Peer-to-peer gossip cannot guarantee consensus or instantaneous deletion during concurrent verification races.

## Invariant Verification

| Invariant | Mechanism |
|---|---|
| **1. Exactly-Once Consumption** | Postgres atomic `DELETE ... WHERE nonce = $1` guarantees only one verification succeeds under concurrency. |
| **2. Expiry Rejection & Sweep** | Verified with `expiration > now` checks and periodic cleanup indexes. |
| **3. Eviction Isolation** | Per-address bucket caps (5/wallet) ensure attacker traffic on Address A cannot evict Address B. |
| **4. Distributed Rate Limiting** | Sliding window on IP and address enforced on challenge and verify endpoints. |
| **5. Explicit Failure Mode** | Database errors produce explicit `503 STORE_UNAVAILABLE` rather than failing open. |

## Residual Weaknesses, Stated Plainly

- **Shared Public IP NATs**: Users behind a single corporate proxy or university NAT share the IP rate limit bucket (mitigated by generous 30/min IP limit combined with independent per-address rate limiting).

## Test Coverage

- `__tests__/auth/multiInstanceChallengeStore.test.ts`:
  - Cross-instance issue-and-verify simulation.
  - Concurrent consumption race on identical nonce (exactly one succeeds).
  - Eviction isolation under 1,000 attacker requests.
  - Expired challenge rejection.
  - Store unavailability explicit failure handling.
- `__tests__/auth/rateLimiter.test.ts`:
  - IP and address sliding-window rate limit enforcement.
  - Recovery after window expiry.
