import type {
  CacheEntry,
  CacheKeyParams,
  CacheMetrics,
  CacheOptions,
  EntityType,
  InvalidationFilter,
} from "./types";
import { buildMetadataCacheKey, normalizeNetwork, normalizeTenant } from "./keyBuilder";

/** Default TTLs tailored to each entity category */
const DEFAULT_TTLS: Record<
  string,
  { ttlMs: number; staleTtlMs: number; negativeTtlMs: number }
> = {
  contract_meta: { ttlMs: 3_600_000, staleTtlMs: 1_800_000, negativeTtlMs: 10_000 }, // 1 hr / 30 min / 10s
  asset:         { ttlMs: 1_800_000, staleTtlMs: 900_000,   negativeTtlMs: 10_000 }, // 30 min / 15 min / 10s
  trustline:     { ttlMs: 60_000,    staleTtlMs: 30_000,    negativeTtlMs: 5_000 },  // 60s / 30s / 5s
  account_state: { ttlMs: 30_000,    staleTtlMs: 15_000,    negativeTtlMs: 5_000 },  // 30s / 15s / 5s
  ledger_params: { ttlMs: 60_000,    staleTtlMs: 45_000,    negativeTtlMs: 5_000 },  // 60s / 45s / 5s
  default:       { ttlMs: 60_000,    staleTtlMs: 30_000,    negativeTtlMs: 5_000 },
};

export class BoundedMetadataCache {
  private readonly maxCapacity: number;
  private readonly entries = new Map<string, CacheEntry<any>>();
  private readonly inFlight = new Map<string, Promise<any>>();

  private hits = 0;
  private misses = 0;
  private staleHits = 0;
  private negativeHits = 0;
  private writes = 0;
  private evictions = 0;
  private invalidations = 0;

  constructor(maxCapacity = 1000) {
    this.maxCapacity = Math.max(1, maxCapacity);
  }

  /**
   * Fetches data with safe caching, network/tenant key isolation,
   * stale-while-revalidate, and short-lived negative caching.
   */
  async fetchWithCache<T>(
    params: CacheKeyParams,
    fetcher: () => Promise<T>,
    options: CacheOptions = {},
  ): Promise<T> {
    const key = buildMetadataCacheKey(params);
    const now = Date.now();

    // 1. Force refresh bypass
    if (!options.forceRefresh) {
      const cached = this.entries.get(key);
      if (cached) {
        // If not expired
        if (now < cached.expiresAt) {
          cached.lastAccessedAt = now;
          cached.hitCount++;

          if (cached.isNegative) {
            this.negativeHits++;
            return cached.value as T;
          }

          // Check if stale for SWR
          const isStale = now >= cached.staleAt;
          if (isStale) {
            this.staleHits++;
            if (options.allowStale !== false) {
              // Trigger asynchronous background revalidation
              this.revalidateInBackground(key, params, fetcher, options);
              return cached.value as T;
            }
          } else {
            this.hits++;
            return cached.value as T;
          }
        } else {
          // Expired: remove and treat as miss
          this.entries.delete(key);
        }
      }
    }

    this.misses++;

    // 2. In-flight request deduplication: collapse concurrent fetches for the same key
    const existingPromise = this.inFlight.get(key);
    if (existingPromise) {
      return existingPromise as Promise<T>;
    }

    const fetchPromise = (async () => {
      try {
        const freshValue = await fetcher();
        const isNeg = this.determineIfNegative(freshValue, options);
        this.writeEntry(key, params, freshValue, isNeg, options);
        return freshValue;
      } catch (err: unknown) {
        // Check if error is a 404 or NotFound that qualifies for negative caching
        if (this.isNotFoundError(err)) {
          // Negative result: e.g. unfunded account
          const negativeVal = null as unknown as T;
          this.writeEntry(key, params, negativeVal, true, options);
          throw err;
        }
        throw err;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, fetchPromise);
    return fetchPromise;
  }

  /**
   * Directly sets a value in the cache with the given key parameters.
   */
  set<T>(
    params: CacheKeyParams,
    value: T,
    options: CacheOptions = {},
  ): CacheEntry<T> {
    const key = buildMetadataCacheKey(params);
    const isNeg = this.determineIfNegative(value, options);
    return this.writeEntry(key, params, value, isNeg, options);
  }

  /**
   * Direct cache lookup without triggering a fetch.
   */
  get<T>(
    params: CacheKeyParams,
  ): { entry: CacheEntry<T>; isStale: boolean; isNegative: boolean } | null {
    const key = buildMetadataCacheKey(params);
    const cached = this.entries.get(key);
    if (!cached) return null;

    const now = Date.now();
    if (now >= cached.expiresAt) {
      this.entries.delete(key);
      return null;
    }

    cached.lastAccessedAt = now;
    return {
      entry: cached,
      isStale: now >= cached.staleAt,
      isNegative: cached.isNegative,
    };
  }

  /**
   * Invalidates a specific key directly.
   */
  invalidate(key: string): boolean {
    if (this.entries.delete(key)) {
      this.invalidations++;
      return true;
    }
    return false;
  }

  /**
   * Invalidates an entry by its structured parameters.
   */
  invalidateByParams(params: CacheKeyParams): boolean {
    return this.invalidate(buildMetadataCacheKey(params));
  }

  /**
   * Selectively invalidates entries matching any combination of network,
   * tenant, entityType, and entityId.
   */
  invalidateByFilter(filter: InvalidationFilter): number {
    let count = 0;
    const targetNetwork = filter.network ? normalizeNetwork(filter.network) : null;
    const targetTenant =
      filter.tenantWallet !== undefined
        ? normalizeTenant(filter.tenantWallet)
        : null;

    for (const [key, entry] of this.entries.entries()) {
      let matches = true;

      if (targetNetwork && entry.network !== targetNetwork) {
        matches = false;
      }
      if (matches && targetTenant && normalizeTenant(entry.tenantWallet) !== targetTenant) {
        matches = false;
      }
      if (matches && filter.entityType && entry.entityType !== filter.entityType) {
        matches = false;
      }
      if (matches && filter.entityId && entry.entityId !== filter.entityId) {
        matches = false;
      }

      if (matches) {
        this.entries.delete(key);
        count++;
      }
    }

    this.invalidations += count;
    return count;
  }

  /**
   * Invalidates all cached state for a given tenant wallet.
   * Useful when an account transacts or when user switches/disconnects.
   */
  invalidateTenant(tenantWallet: string, network?: string): number {
    return this.invalidateByFilter({ tenantWallet, network });
  }

  /**
   * Invalidates all cached entries for a given entity type (e.g. "trustline").
   */
  invalidateEntityType(entityType: EntityType, network?: string): number {
    return this.invalidateByFilter({ entityType, network });
  }

  /**
   * Returns current cache operational metrics.
   */
  getMetrics(): CacheMetrics {
    const totalLookups = this.hits + this.staleHits + this.negativeHits + this.misses;
    const totalHits = this.hits + this.staleHits + this.negativeHits;
    const hitRatio = totalLookups > 0 ? totalHits / totalLookups : 0;

    return {
      hits: this.hits,
      misses: this.misses,
      staleHits: this.staleHits,
      negativeHits: this.negativeHits,
      writes: this.writes,
      evictions: this.evictions,
      invalidations: this.invalidations,
      currentSize: this.entries.size,
      maxCapacity: this.maxCapacity,
      hitRatio: Math.round(hitRatio * 1000) / 1000,
    };
  }

  /**
   * Returns a diagnostic summary of all stored keys.
   */
  getEntriesSummary(): Array<{
    key: string;
    network: string;
    tenant: string | null;
    entityType: string;
    entityId: string;
    isNegative: boolean;
    isStale: boolean;
    ttlRemainingMs: number;
    hits: number;
  }> {
    const now = Date.now();
    const summary: Array<any> = [];

    for (const [key, entry] of this.entries.entries()) {
      summary.push({
        key,
        network: entry.network,
        tenant: entry.tenantWallet,
        entityType: entry.entityType,
        entityId: entry.entityId,
        isNegative: entry.isNegative,
        isStale: now >= entry.staleAt,
        ttlRemainingMs: Math.max(0, entry.expiresAt - now),
        hits: entry.hitCount,
      });
    }

    return summary;
  }

  /**
   * Clears all entries and resets metrics.
   */
  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
    this.hits = 0;
    this.misses = 0;
    this.staleHits = 0;
    this.negativeHits = 0;
    this.writes = 0;
    this.evictions = 0;
    this.invalidations = 0;
  }

  // ── Internal Helpers ────────────────────────────────────────────────────────

  private writeEntry<T>(
    key: string,
    params: CacheKeyParams,
    value: T,
    isNegative: boolean,
    options: CacheOptions,
  ): CacheEntry<T> {
    const now = Date.now();
    const defaults = DEFAULT_TTLS[params.entityType] || DEFAULT_TTLS.default;

    let expiresAt: number;
    let staleAt: number;

    if (isNegative) {
      const negativeTtl = options.negativeTtlMs ?? defaults.negativeTtlMs;
      expiresAt = now + negativeTtl;
      staleAt = now + Math.floor(negativeTtl / 2);
    } else {
      const ttl = options.ttlMs ?? defaults.ttlMs;
      const staleTtl = options.staleTtlMs ?? defaults.staleTtlMs;
      expiresAt = now + ttl;
      staleAt = now + staleTtl;
    }

    // Bounded capacity check: evict LRU if full
    if (!this.entries.has(key) && this.entries.size >= this.maxCapacity) {
      this.evictLru();
    }

    const entry: CacheEntry<T> = {
      key,
      value,
      network: normalizeNetwork(params.network),
      tenantWallet: params.tenantWallet ?? null,
      entityType: params.entityType,
      entityId: params.entityId,
      createdAt: now,
      expiresAt,
      staleAt,
      isNegative,
      version: 1,
      hitCount: 0,
      lastAccessedAt: now,
    };

    this.entries.set(key, entry);
    this.writes++;
    return entry;
  }

  private evictLru(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.entries.entries()) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.entries.delete(oldestKey);
      this.evictions++;
    }
  }

  private revalidateInBackground<T>(
    key: string,
    params: CacheKeyParams,
    fetcher: () => Promise<T>,
    options: CacheOptions,
  ): void {
    if (this.inFlight.has(key)) return;

    const bgPromise = (async () => {
      try {
        const freshValue = await fetcher();
        const isNeg = this.determineIfNegative(freshValue, options);
        this.writeEntry(key, params, freshValue, isNeg, options);
      } catch {
        // Background revalidation failure silently keeps existing entry until expiry
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, bgPromise);
  }

  private determineIfNegative(value: any, options: CacheOptions): boolean {
    if (options.isNegative) {
      return options.isNegative(value);
    }
    if (value === false || value === null) {
      return true;
    }
    if (typeof value === "object" && value !== null && "status" in value && value.status === "unfunded") {
      return true;
    }
    return false;
  }

  private isNotFoundError(err: unknown): boolean {
    if (typeof err === "object" && err !== null) {
      if ("status" in err && (err as { status: number }).status === 404) return true;
      if ("response" in err) {
        const res = (err as { response?: { status?: number } }).response;
        if (res?.status === 404) return true;
      }
      if ("name" in err && (err as { name?: string }).name === "NotFoundError") return true;
    }
    return false;
  }
}
