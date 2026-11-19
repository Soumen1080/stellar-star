import { BoundedMetadataCache } from "./store";
import type { CacheOptions } from "./types";
import { assetKey, isNative, type AssetRef } from "@/lib/stellar/assets";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import type { AccountState } from "@/lib/stellar/accountState";

/**
 * Global singleton bounded metadata cache for Stellar chain reads.
 * Default capacity: 1,000 entries.
 */
export const chainMetadataCache = new BoundedMetadataCache(1000);

/**
 * Reads trustline presence with safe tenant-scoped and network-scoped caching.
 *
 * Scoped strictly by (network, tenantPublicKey, assetKey):
 *  - Native XLM returns true immediately without caching or network calls.
 *  - Tenant isolation ensures Tenant A's trustlines never leak to Tenant B.
 *  - Negative results (trustline does not exist) are cached with a short 5-second TTL
 *    so newly established trustlines are recognized quickly.
 *  - Positive results are cached with a 60-second TTL.
 */
export async function getCachedTrustline(
  publicKey: string,
  asset: AssetRef,
  fetcher: () => Promise<boolean>,
  options: CacheOptions = {},
): Promise<boolean> {
  if (isNative(asset)) return true;

  const aKey = assetKey(asset);
  return chainMetadataCache.fetchWithCache<boolean>(
    {
      network: NETWORK_PASSPHRASE,
      tenantWallet: publicKey,
      entityType: "trustline",
      entityId: aKey,
    },
    fetcher,
    {
      ttlMs: 60_000,
      staleTtlMs: 30_000,
      negativeTtlMs: 5_000,
      isNegative: (val) => val === false,
      ...options,
    },
  );
}

/**
 * Invalidates cached trustline state for an account.
 * Call this when a ChangeTrust transaction is submitted or confirmed.
 */
export function invalidateTrustlineCache(
  publicKey: string,
  asset?: AssetRef,
  network: string = NETWORK_PASSPHRASE,
): number {
  if (asset) {
    return chainMetadataCache.invalidateByFilter({
      network,
      tenantWallet: publicKey,
      entityType: "trustline",
      entityId: assetKey(asset),
    });
  }
  return chainMetadataCache.invalidateByFilter({
    network,
    tenantWallet: publicKey,
    entityType: "trustline",
  });
}

/**
 * Reads immutable or rarely-changing contract metadata (e.g. pool contract ID)
 * with network-scoped caching.
 *
 * Scoped by (network, contractId, metadataKey) with global tenant context:
 *  - Does not leak across testnet/mainnet.
 *  - Avoids redundant Soroban transaction simulations.
 *  - TTL is 1 hour with 30-minute stale revalidation.
 */
export async function getCachedContractMetadata<T>(
  contractId: string,
  metadataKey: string,
  fetcher: () => Promise<T>,
  options: CacheOptions = {},
): Promise<T> {
  return chainMetadataCache.fetchWithCache<T>(
    {
      network: NETWORK_PASSPHRASE,
      tenantWallet: null, // Global network metadata
      entityType: "contract_meta",
      entityId: `${contractId}:${metadataKey}`,
    },
    fetcher,
    {
      ttlMs: 3_600_000, // 1 hour
      staleTtlMs: 1_800_000, // 30 minutes
      negativeTtlMs: 10_000,
      ...options,
    },
  );
}

/**
 * Specifically caches the settlement pool contract ID retrieved via simulation.
 */
export async function getCachedPoolContractId(
  settlementContractId: string,
  fetcher: () => Promise<string>,
  options: CacheOptions = {},
): Promise<string> {
  return getCachedContractMetadata<string>(
    settlementContractId,
    "pool_contract",
    fetcher,
    options,
  );
}

/**
 * Invalidates contract metadata cache (e.g. after upgrade).
 */
export function invalidateContractMetadataCache(
  contractId: string,
  metadataKey?: string,
  network: string = NETWORK_PASSPHRASE,
): number {
  if (metadataKey) {
    return chainMetadataCache.invalidateByFilter({
      network,
      tenantWallet: null,
      entityType: "contract_meta",
      entityId: `${contractId}:${metadataKey}`,
    });
  }
  return chainMetadataCache.invalidateByFilter({
    network,
    tenantWallet: null,
    entityType: "contract_meta",
  });
}

/**
 * Reads live ledger base reserve with network-scoped caching.
 */
export async function getCachedBaseReserve(
  fetcher: () => Promise<bigint>,
  network: string = NETWORK_PASSPHRASE,
  options: CacheOptions = {},
): Promise<bigint> {
  return chainMetadataCache.fetchWithCache<bigint>(
    {
      network,
      tenantWallet: null,
      entityType: "ledger_params",
      entityId: "base_reserve",
    },
    fetcher,
    {
      ttlMs: 60_000,
      staleTtlMs: 45_000,
      negativeTtlMs: 5_000,
      ...options,
    },
  );
}

/**
 * Reads account state with safe tenant and network scoping.
 *
 * Negative result: when status === "unfunded", short negative TTL (5s) prevents
 * permanently caching a new account as missing while it is being onboarded.
 */
export async function getCachedAccountState(
  publicKey: string,
  fetcher: () => Promise<AccountState>,
  options: CacheOptions = {},
): Promise<AccountState> {
  return chainMetadataCache.fetchWithCache<AccountState>(
    {
      network: NETWORK_PASSPHRASE,
      tenantWallet: publicKey,
      entityType: "account_state",
      entityId: publicKey,
    },
    fetcher,
    {
      ttlMs: 30_000,
      staleTtlMs: 15_000,
      negativeTtlMs: 5_000,
      isNegative: (state: AccountState) => state.status === "unfunded",
      ...options,
    },
  );
}

/**
 * Invalidates all cached state (trustlines, balances, account states)
 * for a specific tenant wallet address.
 */
export function invalidateTenantCache(
  tenantWallet: string,
  network: string = NETWORK_PASSPHRASE,
): number {
  return chainMetadataCache.invalidateTenant(tenantWallet, network);
}
