import {
  BoundedMetadataCache,
  buildMetadataCacheKey,
  parseMetadataCacheKey,
  chainMetadataCache,
  getCachedTrustline,
  invalidateTrustlineCache,
  getCachedPoolContractId,
  invalidateContractMetadataCache,
  getCachedBaseReserve,
} from "@/lib/stellar/cache";
import { CIRCLE_USDC_ISSUER_TESTNET, CIRCLE_USDC_ISSUER_PUBLIC } from "@/lib/stellar/assets";

describe("Chain Metadata Cache Architecture (#427)", () => {
  const TENANT_A = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
  const TENANT_B = "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ";
  const USDC_TESTNET = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };

  beforeEach(() => {
    chainMetadataCache.clear();
  });

  describe("Deterministic Key Scoping", () => {
    it("generates network-isolated cache keys", () => {
      const testnetKey = buildMetadataCacheKey({
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC",
      });

      const mainnetKey = buildMetadataCacheKey({
        network: "mainnet",
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC",
      });

      expect(testnetKey).toContain("testnet");
      expect(mainnetKey).toContain("mainnet");
      expect(testnetKey).not.toEqual(mainnetKey);
    });

    it("generates tenant-isolated cache keys", () => {
      const keyA = buildMetadataCacheKey({
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC",
      });

      const keyB = buildMetadataCacheKey({
        network: "testnet",
        tenantWallet: TENANT_B,
        entityType: "trustline",
        entityId: "USDC",
      });

      expect(keyA).toContain(TENANT_A);
      expect(keyB).toContain(TENANT_B);
      expect(keyA).not.toEqual(keyB);
    });

    it("uses global scope for contract and ledger metadata", () => {
      const contractKey = buildMetadataCacheKey({
        network: "testnet",
        tenantWallet: null,
        entityType: "contract_meta",
        entityId: "contract123:pool_contract",
      });

      expect(contractKey).toContain("t:_global_");
    });

    it("parses valid keys back into structured components", () => {
      const key = buildMetadataCacheKey({
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC:GBBD",
      });

      const parsed = parseMetadataCacheKey(key);
      expect(parsed).toEqual({
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC:GBBD",
      });
    });
  });

  describe("Provider Call Reduction", () => {
    it("serves subsequent reads from cache, executing the provider fetcher only once", async () => {
      const cache = new BoundedMetadataCache(100);
      let providerCalls = 0;
      const fetcher = jest.fn(async () => {
        providerCalls++;
        return { poolId: "CDLZ_MOCK_POOL" };
      });

      const params = {
        network: "testnet",
        tenantWallet: null,
        entityType: "contract_meta",
        entityId: "settlement:pool",
      };

      // 5 consecutive calls
      const r1 = await cache.fetchWithCache(params, fetcher);
      const r2 = await cache.fetchWithCache(params, fetcher);
      const r3 = await cache.fetchWithCache(params, fetcher);
      const r4 = await cache.fetchWithCache(params, fetcher);
      const r5 = await cache.fetchWithCache(params, fetcher);

      expect(r1).toEqual({ poolId: "CDLZ_MOCK_POOL" });
      expect(r2).toEqual({ poolId: "CDLZ_MOCK_POOL" });
      expect(r5).toEqual({ poolId: "CDLZ_MOCK_POOL" });
      expect(providerCalls).toBe(1);

      const metrics = cache.getMetrics();
      expect(metrics.hits).toBe(4);
      expect(metrics.misses).toBe(1);
      expect(metrics.hitRatio).toBeGreaterThanOrEqual(0.8);
    });

    it("deduplicates concurrent in-flight requests into a single network call", async () => {
      const cache = new BoundedMetadataCache(100);
      let providerCalls = 0;

      const slowFetcher = jest.fn(async () => {
        providerCalls++;
        await new Promise((r) => setTimeout(r, 20));
        return "slow-resolved-value";
      });

      const params = {
        network: "testnet",
        tenantWallet: null,
        entityType: "ledger_params",
        entityId: "base_reserve",
      };

      // Launch 5 calls concurrently
      const results = await Promise.all([
        cache.fetchWithCache(params, slowFetcher),
        cache.fetchWithCache(params, slowFetcher),
        cache.fetchWithCache(params, slowFetcher),
        cache.fetchWithCache(params, slowFetcher),
        cache.fetchWithCache(params, slowFetcher),
      ]);

      expect(results).toEqual([
        "slow-resolved-value",
        "slow-resolved-value",
        "slow-resolved-value",
        "slow-resolved-value",
        "slow-resolved-value",
      ]);
      expect(providerCalls).toBe(1);
    });
  });

  describe("Network and Tenant Isolation Guarantees", () => {
    it("ensures mainnet reads never return testnet cached state", async () => {
      const cache = new BoundedMetadataCache(100);

      const testnetFetcher = jest.fn(async () => "TESTNET_ASSET_DATA");
      const mainnetFetcher = jest.fn(async () => "MAINNET_ASSET_DATA");

      const testnetResult = await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "USDC" },
        testnetFetcher,
      );

      const mainnetResult = await cache.fetchWithCache(
        { network: "mainnet", tenantWallet: null, entityType: "asset", entityId: "USDC" },
        mainnetFetcher,
      );

      expect(testnetResult).toBe("TESTNET_ASSET_DATA");
      expect(mainnetResult).toBe("MAINNET_ASSET_DATA");
      expect(testnetFetcher).toHaveBeenCalledTimes(1);
      expect(mainnetFetcher).toHaveBeenCalledTimes(1);
    });

    it("ensures Tenant A's trustlines never leak to Tenant B", async () => {
      const cache = new BoundedMetadataCache(100);

      // Tenant A has trustline
      const fetcherA = jest.fn(async () => true);
      // Tenant B does not have trustline
      const fetcherB = jest.fn(async () => false);

      const hasA = await cache.fetchWithCache(
        { network: "testnet", tenantWallet: TENANT_A, entityType: "trustline", entityId: "USDC" },
        fetcherA,
      );

      const hasB = await cache.fetchWithCache(
        { network: "testnet", tenantWallet: TENANT_B, entityType: "trustline", entityId: "USDC" },
        fetcherB,
      );

      expect(hasA).toBe(true);
      expect(hasB).toBe(false);
      expect(fetcherA).toHaveBeenCalledTimes(1);
      expect(fetcherB).toHaveBeenCalledTimes(1);
    });
  });

  describe("Short-Lived Negative Caching", () => {
    it("expires negative results quickly while keeping positive results cached", async () => {
      const cache = new BoundedMetadataCache(100);
      let accountStatus = "unfunded";

      const fetcher = jest.fn(async () => {
        return { status: accountStatus };
      });

      const params = {
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "account_state",
        entityId: TENANT_A,
      };

      // 1. Initial check: unfunded (negative result)
      const res1 = await cache.fetchWithCache(params, fetcher, {
        ttlMs: 60_000,
        negativeTtlMs: 25, // Short negative TTL (25ms)
      });
      expect(res1.status).toBe("unfunded");
      expect(fetcher).toHaveBeenCalledTimes(1);

      // 2. Immediate second call: served from negative cache
      const res2 = await cache.fetchWithCache(params, fetcher, {
        ttlMs: 60_000,
        negativeTtlMs: 25,
      });
      expect(res2.status).toBe("unfunded");
      expect(fetcher).toHaveBeenCalledTimes(1); // No new provider call

      // 3. User funds their account on-chain
      accountStatus = "funded";

      // Wait 35ms for the short negative TTL to expire
      await new Promise((r) => setTimeout(r, 35));

      // 4. Next read must detect the expiration and fetch fresh state
      const res3 = await cache.fetchWithCache(params, fetcher, {
        ttlMs: 60_000,
        negativeTtlMs: 25,
      });
      expect(res3.status).toBe("funded");
      expect(fetcher).toHaveBeenCalledTimes(2); // Provider called again
    });
  });

  describe("State Change Invalidation", () => {
    it("immediately flushes stale data when invalidation is triggered", async () => {
      const cache = new BoundedMetadataCache(100);
      let trustlineExists = false;

      const fetcher = jest.fn(async () => trustlineExists);

      const params = {
        network: "testnet",
        tenantWallet: TENANT_A,
        entityType: "trustline" as const,
        entityId: "USDC",
      };

      // 1. Check trustline: returns false
      const r1 = await cache.fetchWithCache(params, fetcher, {
        ttlMs: 60_000,
        negativeTtlMs: 60_000,
      });
      expect(r1).toBe(false);
      expect(fetcher).toHaveBeenCalledTimes(1);

      // 2. Change state: user submits ChangeTrust transaction
      trustlineExists = true;

      // Invalidate cache for tenant A
      const evicted = cache.invalidateTenant(TENANT_A, "testnet");
      expect(evicted).toBe(1);

      // 3. Next read fetches fresh state immediately without waiting for TTL
      const r2 = await cache.fetchWithCache(params, fetcher);
      expect(r2).toBe(true);
      expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it("supports selective entity invalidation without purging unrelated cache", async () => {
      const cache = new BoundedMetadataCache(100);

      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: TENANT_A, entityType: "trustline", entityId: "USDC" },
        async () => true,
      );

      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: TENANT_A, entityType: "trustline", entityId: "EURC" },
        async () => true,
      );

      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "ledger_params", entityId: "base_reserve" },
        async () => 5_000_000n,
      );

      expect(cache.getMetrics().currentSize).toBe(3);

      // Invalidate only the USDC trustline for Tenant A
      cache.invalidateByFilter({
        tenantWallet: TENANT_A,
        entityType: "trustline",
        entityId: "USDC",
      });

      expect(cache.getMetrics().currentSize).toBe(2);

      // Ledger params and EURC trustline must still be cached
      const ledgerEntry = cache.get({
        network: "testnet",
        tenantWallet: null,
        entityType: "ledger_params",
        entityId: "base_reserve",
      });
      expect(ledgerEntry).not.toBeNull();
      expect(ledgerEntry?.entry.value).toBe(5_000_000n);
    });
  });

  describe("Bounded Capacity & LRU Eviction", () => {
    it("strictly bounds cache entries to maxCapacity by evicting least recently used", async () => {
      const maxCap = 3;
      const cache = new BoundedMetadataCache(maxCap);

      // Insert 3 items
      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-1" },
        async () => "val-1",
      );
      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-2" },
        async () => "val-2",
      );
      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-3" },
        async () => "val-3",
      );

      expect(cache.getMetrics().currentSize).toBe(3);

      // Access asset-1 again to update its lastAccessedAt timestamp
      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-1" },
        async () => "val-1",
      );

      // Insert 4th item: should evict asset-2 (least recently used)
      await cache.fetchWithCache(
        { network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-4" },
        async () => "val-4",
      );

      expect(cache.getMetrics().currentSize).toBe(3);
      expect(cache.getMetrics().evictions).toBe(1);

      // asset-1 and asset-4 should be in cache; asset-2 should be evicted
      const entry1 = cache.get({ network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-1" });
      const entry2 = cache.get({ network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-2" });
      const entry4 = cache.get({ network: "testnet", tenantWallet: null, entityType: "asset", entityId: "asset-4" });

      expect(entry1).not.toBeNull();
      expect(entry4).not.toBeNull();
      expect(entry2).toBeNull(); // Evicted
    });
  });

  describe("Stellar Helpers Integration", () => {
    it("getCachedTrustline caches positive and negative trustline reads with tenant isolation", async () => {
      let callCount = 0;
      const fetcher = async () => {
        callCount++;
        return true;
      };

      const res1 = await getCachedTrustline(TENANT_A, USDC_TESTNET, fetcher);
      const res2 = await getCachedTrustline(TENANT_A, USDC_TESTNET, fetcher);

      expect(res1).toBe(true);
      expect(res2).toBe(true);
      expect(callCount).toBe(1);

      // Invalidate
      invalidateTrustlineCache(TENANT_A, USDC_TESTNET);

      const res3 = await getCachedTrustline(TENANT_A, USDC_TESTNET, fetcher);
      expect(res3).toBe(true);
      expect(callCount).toBe(2);
    });

    it("getCachedPoolContractId caches Soroban pool simulation", async () => {
      let simCalls = 0;
      const simFetcher = async () => {
        simCalls++;
        return "C_POOL_CONTRACT_ADDRESS_789";
      };

      const p1 = await getCachedPoolContractId("C_SETTLEMENT_CONTRACT", simFetcher);
      const p2 = await getCachedPoolContractId("C_SETTLEMENT_CONTRACT", simFetcher);

      expect(p1).toBe("C_POOL_CONTRACT_ADDRESS_789");
      expect(p2).toBe("C_POOL_CONTRACT_ADDRESS_789");
      expect(simCalls).toBe(1);

      invalidateContractMetadataCache("C_SETTLEMENT_CONTRACT");

      const p3 = await getCachedPoolContractId("C_SETTLEMENT_CONTRACT", simFetcher);
      expect(p3).toBe("C_POOL_CONTRACT_ADDRESS_789");
      expect(simCalls).toBe(2);
    });
  });
});
