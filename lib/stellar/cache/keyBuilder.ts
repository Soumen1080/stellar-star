import { NETWORK_PASSPHRASE, STELLAR_NETWORK } from "@/lib/utils/constants";
import type { CacheKeyParams } from "./types";

/**
 * Normalizes a network string into a canonical, collision-free identifier.
 * Prevents testnet state from ever being served for mainnet or vice versa.
 */
export function normalizeNetwork(network?: string): string {
  const target = network?.trim() || NETWORK_PASSPHRASE || STELLAR_NETWORK || "TESTNET";

  if (
    target.includes("Public Global Stellar Network") ||
    target.toUpperCase() === "PUBLIC" ||
    target.toLowerCase() === "mainnet"
  ) {
    return "mainnet";
  }

  if (
    target.includes("Test SDF Network") ||
    target.toUpperCase() === "TESTNET" ||
    target.toLowerCase() === "testnet"
  ) {
    return "testnet";
  }

  if (
    target.includes("Test SDF Future Network") ||
    target.toUpperCase() === "FUTURENET" ||
    target.toLowerCase() === "futurenet"
  ) {
    return "futurenet";
  }

  // Sanitize custom network passphrases into safe key characters
  return `custom_${target.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 32)}`;
}

/**
 * Normalizes a tenant wallet identifier.
 * When tenantWallet is provided, scopes the cache key to that tenant.
 * When omitted or null, scopes the key to the global context for immutable chain data.
 */
export function normalizeTenant(tenantWallet?: string | null): string {
  if (!tenantWallet || typeof tenantWallet !== "string" || tenantWallet.trim() === "") {
    return "t:_global_";
  }
  return `t:${tenantWallet.trim()}`;
}

/**
 * Builds a deterministic, collision-proof cache key.
 * Format: `stellar:${network}:${tenant}:${entityType}:${entityId}`
 */
export function buildMetadataCacheKey(params: CacheKeyParams): string {
  const network = normalizeNetwork(params.network);
  const tenant = normalizeTenant(params.tenantWallet);
  const entityType = params.entityType.trim();
  const entityId = params.entityId.trim();

  return `stellar:${network}:${tenant}:${entityType}:${entityId}`;
}

/**
 * Parses a metadata cache key back into its components.
 */
export function parseMetadataCacheKey(key: string): CacheKeyParams | null {
  const parts = key.split(":");
  if (parts.length < 5 || parts[0] !== "stellar") {
    return null;
  }

  const network = parts[1];
  // tenant is format "t:address" or "t:_global_"
  const tenantRaw = parts[2] === "t" ? parts[3] : parts[2];
  const isGlobal = tenantRaw === "_global_";
  const entityType = parts[parts[2] === "t" ? 4 : 3];
  const entityId = parts.slice(parts[2] === "t" ? 5 : 4).join(":");

  return {
    network,
    tenantWallet: isGlobal ? null : tenantRaw,
    entityType,
    entityId,
  };
}
