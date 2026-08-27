/**
 * Making N sponsored accounts cost an attacker something that scales.
 *
 * The threat is concrete: sponsorship locks the sponsor's XLM durably, so
 * scripting account creation drains the sponsor's capacity without the attacker
 * spending anything. A cap alone bounds the damage but does not prevent it — an
 * attacker who exhausts the cap has denied service to every real user, for free.
 *
 * So sponsorship is not offered to anonymous requesters. It is *earned by an
 * inviter*, and the costs below all attach to that inviter's identity rather
 * than to the account being created, because the account being created is free
 * to generate and the inviter is not.
 *
 * ## The three costs, and what each one stops
 *
 * 1. **An established inviter.** Only a wallet that is itself funded and has
 *    proven ownership can sponsor. Creating a fresh inviter therefore costs a
 *    real funded account — the very thing sponsorship provides — so the attack
 *    does not bootstrap itself.
 *
 * 2. **A per-inviter quota.** One wallet can sponsor a bounded number of
 *    accounts. N accounts needs N/quota distinct funded inviters, so cost grows
 *    linearly in N rather than being amortised to nothing.
 *
 * 3. **A cooldown.** Sponsorships per inviter are rate-limited over time, so
 *    even a legitimate-looking inviter cannot burn the global cap in one script
 *    run. This converts a burst into a slow drip that monitoring can catch.
 *
 * None of these is individually sufficient. Together they mean the marginal
 * cost of the Nth sponsored account is bounded below by the cost of acquiring
 * and funding roughly N/quota Stellar accounts.
 */

import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";
import { getAccountState } from "@/lib/stellar/accountState";

const TABLE = "sponsorship_invites";

/** Sponsorships one inviter may hold active at once. */
export const MAX_SPONSORSHIPS_PER_INVITER = Number(
  process.env.MAX_SPONSORSHIPS_PER_INVITER ?? "5",
);

/** Minimum gap between an inviter's sponsorships. */
export const INVITE_COOLDOWN_MS = Number(process.env.INVITE_COOLDOWN_MS ?? String(60 * 60 * 1000));

/**
 * Spendable balance an inviter must hold to sponsor anyone.
 *
 * Not a fee — nothing is taken. It is a proof of stake in the network that
 * costs an attacker real XLM per inviter identity they need to manufacture.
 */
export const INVITER_MIN_SPENDABLE_STROOPS = BigInt(
  process.env.INVITER_MIN_SPENDABLE_STROOPS ?? "50000000",
);

export type RejectionReason =
  | "inviter_unfunded"
  | "inviter_below_threshold"
  | "inviter_quota_exceeded"
  | "inviter_cooldown"
  | "already_sponsored";

export interface EligibilityResult {
  allowed: boolean;
  reason?: RejectionReason;
  message?: string;
  /** When a cooldown is active, when the inviter may try again. */
  retryAfterMs?: number;
}

interface InviteRecord {
  inviter: string;
  invitee: string;
  createdAt: number;
}

declare global {
  var stellarStarInvites: InviteRecord[] | undefined;
}

const memoryInvites = globalThis.stellarStarInvites ?? [];
globalThis.stellarStarInvites = memoryInvites;

function durable(): boolean {
  return isServerSupabaseConfigured() && createServiceRoleClient() !== null;
}

async function invitesBy(inviter: string): Promise<InviteRecord[]> {
  const client = durable() ? createServiceRoleClient() : null;

  if (client) {
    const { data, error } = await client
      .from(TABLE)
      .select("inviter, invitee, created_at_ms")
      .eq("inviter", inviter);

    if (error) throw new Error(`Invite ledger read failed: ${error.message}`);
    return (data ?? []).map((row: Record<string, unknown>) => ({
      inviter: String(row.inviter),
      invitee: String(row.invitee),
      createdAt: Number(row.created_at_ms),
    }));
  }

  return memoryInvites.filter((r) => r.inviter === inviter);
}

/**
 * Whether `inviter` may sponsor `invitee` right now.
 *
 * Every check attaches to the inviter, because the invitee address is free to
 * generate and therefore worthless as a rate-limiting key.
 */
export async function checkEligibility(
  inviter: string,
  invitee: string,
  now: number = Date.now(),
): Promise<EligibilityResult> {
  // Cost 1: the inviter must be a real, funded account. This is what stops the
  // attack bootstrapping itself from sponsored accounts.
  const inviterState = await getAccountState(inviter);

  if (inviterState.status === "unfunded") {
    return {
      allowed: false,
      reason: "inviter_unfunded",
      message:
        "Only a funded Stellar account can invite someone. Fund your own account first.",
    };
  }

  if (inviterState.spendableStroops < INVITER_MIN_SPENDABLE_STROOPS) {
    return {
      allowed: false,
      reason: "inviter_below_threshold",
      message:
        "Your account needs a little more XLM before you can invite others. " +
        "Nothing is taken from you — this only confirms the invite is genuine.",
    };
  }

  const invites = await invitesBy(inviter);

  if (invites.some((r) => r.invitee === invitee)) {
    return {
      allowed: false,
      reason: "already_sponsored",
      message: "You have already sponsored this account.",
    };
  }

  // Cost 2: quota. N accounts requires N/quota distinct funded inviters.
  if (invites.length >= MAX_SPONSORSHIPS_PER_INVITER) {
    return {
      allowed: false,
      reason: "inviter_quota_exceeded",
      message:
        `You have sponsored ${invites.length} accounts, the maximum per wallet. ` +
        "Ask another group member to send the invite.",
    };
  }

  // Cost 3: cooldown. Turns a scripted burst into a drip.
  const mostRecent = invites.reduce((latest, r) => Math.max(latest, r.createdAt), 0);
  const elapsed = now - mostRecent;
  if (mostRecent > 0 && elapsed < INVITE_COOLDOWN_MS) {
    return {
      allowed: false,
      reason: "inviter_cooldown",
      message: "You have invited someone recently. Please wait before inviting another.",
      retryAfterMs: INVITE_COOLDOWN_MS - elapsed,
    };
  }

  return { allowed: true };
}

/** Records a granted invite, so the quota and cooldown see it. */
export async function recordInvite(
  inviter: string,
  invitee: string,
  now: number = Date.now(),
): Promise<void> {
  const client = durable() ? createServiceRoleClient() : null;

  if (client) {
    const { error } = await client.from(TABLE).insert({
      inviter,
      invitee,
      created_at_ms: now,
    });
    // 23505 = unique violation: a concurrent duplicate, which is fine.
    if (error && error.code !== "23505") {
      throw new Error(`Invite ledger write failed: ${error.message}`);
    }
    return;
  }

  memoryInvites.push({ inviter, invitee, createdAt: now });
}

/** Releases an inviter's quota slot when a sponsorship is revoked. */
export async function releaseInvite(inviter: string, invitee: string): Promise<void> {
  const client = durable() ? createServiceRoleClient() : null;

  if (client) {
    await client.from(TABLE).delete().eq("inviter", inviter).eq("invitee", invitee);
    return;
  }

  const index = memoryInvites.findIndex((r) => r.inviter === inviter && r.invitee === invitee);
  if (index >= 0) memoryInvites.splice(index, 1);
}

/** Test seam. */
export function resetMemoryInvites(): void {
  memoryInvites.length = 0;
}
