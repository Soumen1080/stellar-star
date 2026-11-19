# Bounded Stellar Chain Metadata Caching

## 1. Overview & Problem Statement

Stellar client operations frequently execute pre-flight queries for:
- **Trustline status** (`hasTrustline` pre-flight checks before building transactions)
- **Immutable contract metadata** (`get_pool_contract` Soroban simulations)
- **Network parameters** (Ledger base reserve, sequence numbers)
- **Asset metadata** (Issuer account flags, clawback/revocable flags)

Without caching, unconstrained reads add substantial latency to UI workflows and hammer Horizon and Soroban RPC providers with duplicate requests. However, naive caching introduces severe hazards:
1. **Network leakage:** Serving testnet responses for mainnet transactions, potentially causing invalid state assumptions or lost funds.
2. **Cross-tenant data leaks:** Returning Tenant A's trustlines or account state to Tenant B if cache keys do not isolate the tenant wallet.
3. **Stale state traps:** Caching a non-existent account or missing trustline indefinitely, preventing a newly funded user or newly added trustline from transacting.
4. **Unbounded memory:** Storing every lookup indefinitely without capacity limits, leading to Node.js OOMs.

To address **Issue #427**, this module implements a **bounded distributed metadata cache** featuring network- and tenant-scoped keys, safe TTLs, stale-while-revalidate (SWR), short-lived negative caching, and explicit state invalidation.

---

## 2. Architecture & Key Isolation

All cache keys are structured deterministically with strict scoping:

$$\text{Key} = \text{stellar} : \text{network} : \text{tenant} : \text{entityType} : \text{entityId}$$

```
stellar:testnet:t:GBBD47IF6LWK7P7M...:trustline:USDC:GBBD47IF6...
stellar:mainnet:t:_global_:contract_meta:CDLZ...:pool_contract
stellar:testnet:t:_global_:ledger_params:base_reserve
```

### Network Scoping
- Evaluates canonical network identifiers (`"mainnet"`, `"testnet"`, `"futurenet"`, or sanitized passphrase).
- Guarantees testnet and mainnet keys never collide or cross-contaminate.

### Tenant Scoping
- Tenant-specific entities (trustlines, account states, spendable reserves) are keyed by the tenant's Stellar public key (`t:G...`).
- Shared/immutable metadata (contract addresses, asset flags, ledger parameters) uses global scope (`t:_global_`).
- Prevents cross-tenant state leakage.

---

## 3. TTL & Refresh Policies

Different categories of chain metadata possess distinct mutability characteristics:

| Entity Type | TTL | Stale TTL (SWR) | Negative TTL | Purpose |
|---|---|---|---|---|
| `contract_meta` | 1 hour | 30 minutes | 10 seconds | Contract addresses & bytecode hashes (virtually immutable) |
| `asset` / `asset_flags` | 30 minutes | 15 minutes | 10 seconds | Issuer flags & asset configuration |
| `trustline` | 60 seconds | 30 seconds | 5 seconds | Account trustline status |
| `account_state` | 30 seconds | 15 seconds | 5 seconds | Balances, reserves, subentries |
| `ledger_params` | 60 seconds | 45 seconds | 5 seconds | Network base reserve |

### Stale-While-Revalidate (SWR)
When an entry is between `staleAt` and `expiresAt`, the cache immediately returns the cached value to avoid UI latency, while triggering an asynchronous background fetch to refresh the entry from the network provider.

### Short-Lived Negative Caching
When a provider returns 404 (e.g., an unfunded account on Horizon or a non-existent trustline):
- The negative outcome is cached for only **5 seconds** (`negativeTtlMs: 5000`).
- This defends the provider against request spikes when repeated checks occur.
- Critically, it ensures that newly funded accounts or newly confirmed trustlines are recognized within seconds rather than remaining blocked.

---

## 4. Invalidation & Mutation Hooks

State changes must not remain stale. Explicit cache invalidation is integrated into mutation workflows:
- **ChangeTrust Submission:** When `buildChangeTrustTransaction` completes or `submitSignedTransaction` confirms in `useTrustline`, `invalidateTrustlineCache(publicKey, asset)` is triggered immediately.
- **Tenant Reset:** `invalidateTenantCache(tenantWallet)` flushes all state for an account upon disconnect or switch.
- **Contract Migration:** `invalidateContractMetadataCache(contractId)` allows invalidating contract settings upon upgrade.

---

## 5. Developer & Operational Diagnostics

The developer API endpoint at `/api/developer/stellar-cache` enables observability and manual intervention:
- **`GET /api/developer/stellar-cache`**: Returns hit/miss metrics, entry counts, hit ratios, and key summaries.
- **`POST /api/developer/stellar-cache`**: Accepts `{ "action": "invalidate", "tenantWallet": "...", "entityType": "..." }` or `{ "action": "clear" }`.
