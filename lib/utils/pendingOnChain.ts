/**
 * pendingOnChain.ts
 *
 * Helpers to persist/restore/clear a PendingOnChainRecord in localStorage so
 * that partial-success payments survive page refreshes, navigation, and browser
 * restarts.
 *
 * Storage layout:
 *   key   : LS_PENDING_ON_CHAIN  ("StellarStar:pendingOnChain")
 *   value : JSON object mapping  walletPublicKey → { [expenseId]: record }
 *
 * Everything is wallet-scoped so that switching wallets in the same browser
 * session never surfaces another user's retry data.
 */

import { LS_PENDING_ON_CHAIN } from "@/lib/utils/constants";

export interface PendingOnChainRecord {
  memberPublicKey: string;
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  amountXlm: string;
  txHash: string;
  ledger: number;
}

/** Full shape stored under LS_PENDING_ON_CHAIN */
type StoredMap = Record<string, Record<string, PendingOnChainRecord>>;

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function readStoredMap(): StoredMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = localStorage.getItem(LS_PENDING_ON_CHAIN);
    if (!raw) return {};
    return JSON.parse(raw) as StoredMap;
  } catch {
    return {};
  }
}

function writeStoredMap(map: StoredMap): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(LS_PENDING_ON_CHAIN, JSON.stringify(map));
  } catch {
    // Quota exceeded or private-mode restriction — silently skip.
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Persist a pending retry record for the given wallet / expense pair.
 * Overwrites any existing record for that pair.
 */
export function savePendingOnChain(
  publicKey: string,
  record: PendingOnChainRecord,
): void {
  const map = readStoredMap();
  if (!map[publicKey]) map[publicKey] = {};
  map[publicKey][record.expenseId] = record;
  writeStoredMap(map);
}

/**
 * Load a pending retry record for the given wallet / expense pair.
 * Returns `null` if none exists.
 */
export function loadPendingOnChain(
  publicKey: string,
  expenseId: string,
): PendingOnChainRecord | null {
  const map = readStoredMap();
  return map[publicKey]?.[expenseId] ?? null;
}

/**
 * Remove the pending retry record for the given wallet / expense pair.
 * Cleans up the wallet-level key when no more expense records remain.
 */
export function clearPendingOnChain(
  publicKey: string,
  expenseId: string,
): void {
  const map = readStoredMap();
  if (!map[publicKey]) return;
  delete map[publicKey][expenseId];
  if (Object.keys(map[publicKey]).length === 0) {
    delete map[publicKey];
  }
  writeStoredMap(map);
}
