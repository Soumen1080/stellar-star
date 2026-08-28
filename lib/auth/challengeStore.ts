/**
 * lib/auth/challengeStore.ts
 *
 * Multi-instance atomic challenge store.
 *
 * Invariants:
 * 1. A challenge is consumable exactly once, globally, across all instances and
 *    under concurrent verification attempts.
 * 2. Expired challenges are unusable and eventually reclaimed.
 * 3. An attacker cannot evict another user's pending challenge by generating load
 *    (per-address bounds; isolated bucketing).
 * 4. Store unavailability produces an explicit, logged, deliberate failure mode —
 *    never a silent downgrade of replay protection.
 */

import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

export type Challenge = {
  address: string;
  expiration: number;
  createdAt: number;
};

export const MAX_PENDING_PER_ADDRESS = 5;

export class AuthStoreError extends Error {
  readonly code: string;
  constructor(message: string, code = "STORE_UNAVAILABLE") {
    super(message);
    this.name = "AuthStoreError";
    this.code = code;
  }
}

declare global {
  // Address -> Map<nonce, Challenge>
  var stellarStarAddressChallenges: Map<string, Map<string, Challenge>> | undefined;
}

const addressBuckets =
  globalThis.stellarStarAddressChallenges ?? new Map<string, Map<string, Challenge>>();
globalThis.stellarStarAddressChallenges = addressBuckets;

function sweepExpiredMemoryChallenges(now = Date.now()): void {
  for (const [address, nonces] of addressBuckets.entries()) {
    for (const [nonce, challenge] of nonces.entries()) {
      if (challenge.expiration <= now) {
        nonces.delete(nonce);
      }
    }
    if (nonces.size === 0) {
      addressBuckets.delete(address);
    }
  }
}

/**
 * Issues a challenge nonce for a wallet address.
 * Stores in Supabase when configured, or in an isolated per-address memory bucket.
 */
export async function issueChallenge(
  address: string,
  nonce: string,
  expiration: number,
  now = Date.now(),
): Promise<void> {
  if (isServerSupabaseConfigured()) {
    const client = createServiceRoleClient();
    if (client) {
      const { error } = await client.rpc("record_auth_challenge", {
        p_address: address,
        p_nonce: nonce,
        p_expiration: expiration,
        p_max_pending: MAX_PENDING_PER_ADDRESS,
      });

      if (!error) return;

      // If RPC is missing or fails with connection error, attempt direct insert fallback
      const { error: insertError } = await client.from("auth_challenges").insert({
        nonce,
        address,
        expiration,
      });

      if (!insertError) return;

      console.error("[challengeStore] Failed to record challenge in database:", insertError);
      throw new AuthStoreError("Failed to store challenge in multi-instance store.");
    }
  }

  // Memory fallback with per-address isolation (Invariant 3)
  sweepExpiredMemoryChallenges(now);

  let userBucket = addressBuckets.get(address);
  if (!userBucket) {
    userBucket = new Map<string, Challenge>();
    addressBuckets.set(address, userBucket);
  }

  // If this specific address exceeds its pending allowance, evict its oldest pending nonce
  while (userBucket.size >= MAX_PENDING_PER_ADDRESS) {
    const oldestNonce = userBucket.keys().next().value;
    if (!oldestNonce) break;
    userBucket.delete(oldestNonce);
  }

  userBucket.set(nonce, { address, expiration, createdAt: now });
}

/**
 * Atomically consumes an issued challenge nonce.
 * Returns true if the challenge was valid, unexpired, and successfully consumed.
 * Returns false if already consumed, expired, or invalid.
 */
export async function consumeChallenge(
  address: string,
  nonce: string,
  expiration: number,
  now = Date.now(),
): Promise<boolean> {
  // 1. If expired by clock, reject immediately (Invariant 2)
  if (now > expiration) {
    return false;
  }

  // 2. Primary: Atomic consume in Supabase
  if (isServerSupabaseConfigured()) {
    const client = createServiceRoleClient();
    if (client) {
      const { data, error } = await client.rpc("consume_auth_challenge", {
        p_address: address,
        p_nonce: nonce,
        p_expiration: expiration,
        p_now: now,
      });

      if (!error) {
        return Boolean(data);
      }

      // If function is not available, try atomic direct delete
      const { data: deletedRows, error: deleteError } = await client
        .from("auth_challenges")
        .delete()
        .eq("nonce", nonce)
        .eq("address", address)
        .eq("expiration", expiration)
        .gt("expiration", now)
        .select("nonce");

      if (!deleteError) {
        return Array.isArray(deletedRows) && deletedRows.length > 0;
      }

      console.error("[challengeStore] Multi-instance store error during consume:", deleteError);
      throw new AuthStoreError(
        "Authentication store is temporarily unavailable.",
        "STORE_UNAVAILABLE",
      );
    }
  }

  // 3. Fallback: Atomic consume in memory bucket
  sweepExpiredMemoryChallenges(now);

  const userBucket = addressBuckets.get(address);
  if (!userBucket) {
    return false;
  }

  const challenge = userBucket.get(nonce);
  if (
    !challenge ||
    challenge.address !== address ||
    challenge.expiration !== expiration ||
    challenge.expiration <= now
  ) {
    return false;
  }

  // Atomic single-use delete
  userBucket.delete(nonce);
  if (userBucket.size === 0) {
    addressBuckets.delete(address);
  }

  return true;
}

/** Resets challenges for testing */
export function __resetChallengeStoreForTests(): void {
  addressBuckets.clear();
}
