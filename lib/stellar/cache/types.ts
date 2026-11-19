/**
 * Types and interfaces for the bounded Stellar chain metadata cache.
 *
 * Implements Issue #427: Safe caching of immutable and semi-mutable chain
 * metadata (assets, trustlines, contract metadata, ledger parameters) with
 * strict network and tenant scoping, safe TTLs, stale-while-revalidate,
 * and short-lived negative caching.
 */

export type EntityType =
  | "asset"
  | "trustline"
  | "contract_meta"
  | "account_state"
  | "ledger_params"
  | (string & {});

export interface CacheKeyParams {
  /**
   * Network identifier (e.g., "testnet", "mainnet", or network passphrase).
   * Prevents testnet state from ever being served for mainnet.
   */
  network?: string;

  /**
   * Tenant wallet address or user identity.
   * REQUIRED for tenant-specific data (trustlines, balances, account states)
   * to guarantee zero cross-tenant data leakage.
   * Null or omitted for network-wide / immutable contract or asset metadata.
   */
  tenantWallet?: string | null;

  /**
   * Category of entity being cached.
   */
  entityType: EntityType;

  /**
   * Unique identifier of the entity within its category (e.g. asset key "USDC:GBBD...",
   * contract ID, account address, or parameter name).
   */
  entityId: string;
}

export interface CacheEntry<T> {
  key: string;
  value: T;
  network: string;
  tenantWallet: string | null;
  entityType: EntityType;
  entityId: string;
  createdAt: number;
  expiresAt: number;
  staleAt: number;
  isNegative: boolean;
  version: number;
  hitCount: number;
  lastAccessedAt: number;
}

export interface CacheOptions {
  /**
   * Time-to-live in milliseconds before the entry is considered completely expired.
   * Defaults vary by entity type:
   *  - contract_meta: 3,600,000ms (1 hour)
   *  - asset: 1,800,000ms (30 mins)
   *  - trustline: 60,000ms (60 secs)
   *  - account_state: 30,000ms (30 secs)
   *  - ledger_params: 60,000ms (60 secs)
   */
  ttlMs?: number;

  /**
   * Time in milliseconds after which the entry is considered stale and
   * should trigger background revalidation (Stale-While-Revalidate).
   * Defaults to 50% of ttlMs.
   */
  staleTtlMs?: number;

  /**
   * Time-to-live in milliseconds for negative results (e.g. 404 unfunded account,
   * non-existent trustline, missing asset).
   * Defaults to 5,000ms (5 seconds) to ensure state changes do not remain
   * incorrectly stale when an account is funded or a trustline is established.
   */
  negativeTtlMs?: number;

  /**
   * Whether to allow serving stale values while revalidating in the background.
   * Defaults to true.
   */
  allowStale?: boolean;

  /**
   * Custom predicate to determine whether a returned value represents a negative result.
   */
  isNegative?: (value: any) => boolean;

  /**
   * If true, bypasses the cache on read and forces a fresh fetch from the provider,
   * then updates the cache with the new value.
   */
  forceRefresh?: boolean;
}

export interface CacheMetrics {
  hits: number;
  misses: number;
  staleHits: number;
  negativeHits: number;
  writes: number;
  evictions: number;
  invalidations: number;
  currentSize: number;
  maxCapacity: number;
  hitRatio: number;
}

export interface InvalidationFilter {
  network?: string;
  tenantWallet?: string | null;
  entityType?: EntityType;
  entityId?: string;
}
