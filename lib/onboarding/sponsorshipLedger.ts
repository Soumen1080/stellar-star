/**
 * Accounting for sponsored reserves.
 *
 * Sponsorship is a **durable liability**, not a one-off spend. When the app
 * sponsors an account's base reserve, that XLM is locked in the sponsor's
 * account until the sponsorship is revoked — it is not a payment that leaves
 * and is forgotten. An unbounded sponsor is therefore a drain that an attacker
 * can script: create N accounts, lock N × 1.5 XLM, walk away.
 *
 * This module is the thing that makes that bounded (invariant 2) and the record
 * that makes revocation possible (invariant 3). It is the sponsor's balance
 * sheet: every sponsorship is an open liability until explicitly released.
 *
 * ## Storage
 *
 * Supabase when configured, so the cap holds across instances and restarts;
 * otherwise a process-local map. `isDurable()` reports which. This distinction
 * matters more here than elsewhere: a per-process cap on a multi-instance
 * deployment is N times the cap the operator thinks they set, which is exactly
 * the drain the cap exists to prevent.
 */

import { createServiceRoleClient, isServerSupabaseConfigured } from "@/lib/supabase/server";

const TABLE = "sponsored_accounts";

/** Reserve locked per sponsored account: bare account (1 XLM) + one trustline (0.5). */
export const SPONSORSHIP_PER_ACCOUNT_STROOPS = 15_000_000n;

/**
 * Total the sponsor will ever have locked at once.
 *
 * Deliberately a hard number rather than a percentage of balance: a cap that
 * floats with the balance is not a cap, it is a slope. At 1.5 XLM per account
 * this permits 1,000 concurrent sponsorships, and revoking dormant ones is what
 * reclaims headroom rather than raising the ceiling.
 */
export const SPONSORSHIP_CAP_STROOPS =
  BigInt(process.env.SPONSORSHIP_CAP_STROOPS ?? "15000000000");

/** How long a sponsorship may sit unused before it is eligible for reclamation. */
export const SPONSORSHIP_IDLE_RECLAIM_MS = 30 * 24 * 60 * 60 * 1000;

export type SponsorshipStatus = "active" | "revoked" | "reclaimed";

export interface SponsorshipRecord {
  account: string;
  /** Stroops of reserve locked by this sponsorship. */
  lockedStroops: string;
  status: SponsorshipStatus;
  createdAt: number;
  /** Last time the sponsored account did anything, epoch ms. */
  lastActiveAt: number;
  /** The wallet whose invite created this sponsorship — the abuse-cost anchor. */
  sponsoredBy: string;
  revokedAt: number | null;
}

declare global {
  var stellarStarSponsorships: Map<string, SponsorshipRecord> | undefined;
}

const memoryLedger = globalThis.stellarStarSponsorships ?? new Map<string, SponsorshipRecord>();
globalThis.stellarStarSponsorships = memoryLedger;

export function isDurable(): boolean {
  return isServerSupabaseConfigured() && createServiceRoleClient() !== null;
}

function rowToRecord(row: Record<string, unknown>): SponsorshipRecord {
  return {
    account: String(row.account),
    lockedStroops: String(row.locked_stroops),
    status: String(row.status) as SponsorshipStatus,
    createdAt: Number(row.created_at_ms),
    lastActiveAt: Number(row.last_active_at_ms),
    sponsoredBy: String(row.sponsored_by),
    revokedAt: row.revoked_at_ms === null ? null : Number(row.revoked_at_ms),
  };
}

/** Every sponsorship currently holding the sponsor's XLM. */
export async function listActiveSponsorships(): Promise<SponsorshipRecord[]> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { data, error } = await client
      .from(TABLE)
      .select("account, locked_stroops, status, created_at_ms, last_active_at_ms, sponsored_by, revoked_at_ms")
      .eq("status", "active");

    if (error) throw new Error(`Sponsorship ledger read failed: ${error.message}`);
    return (data ?? []).map(rowToRecord);
  }

  return [...memoryLedger.values()].filter((r) => r.status === "active");
}

export async function getSponsorship(account: string): Promise<SponsorshipRecord | null> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { data, error } = await client
      .from(TABLE)
      .select("account, locked_stroops, status, created_at_ms, last_active_at_ms, sponsored_by, revoked_at_ms")
      .eq("account", account)
      .maybeSingle();

    if (error) throw new Error(`Sponsorship ledger read failed: ${error.message}`);
    return data ? rowToRecord(data as Record<string, unknown>) : null;
  }

  return memoryLedger.get(account) ?? null;
}

export interface CapacityReport {
  /** Currently locked across all active sponsorships. */
  committedStroops: bigint;
  /** Cap minus committed. */
  availableStroops: bigint;
  capStroops: bigint;
  activeCount: number;
  /** True when another sponsorship would exceed the cap. */
  exhausted: boolean;
  /** Sponsorships idle long enough to reclaim, which would free headroom. */
  reclaimableCount: number;
  durable: boolean;
}

/**
 * Current exposure against the cap.
 *
 * `reclaimableCount` is reported alongside so exhaustion can be presented as
 * "capacity is recoverable" rather than a flat wall — see invariant 5's
 * exhaustion surface.
 */
export async function getCapacity(now: number = Date.now()): Promise<CapacityReport> {
  const active = await listActiveSponsorships();

  let committedStroops = 0n;
  let reclaimableCount = 0;
  for (const record of active) {
    committedStroops += BigInt(record.lockedStroops);
    if (now - record.lastActiveAt > SPONSORSHIP_IDLE_RECLAIM_MS) reclaimableCount += 1;
  }

  const availableStroops =
    committedStroops >= SPONSORSHIP_CAP_STROOPS ? 0n : SPONSORSHIP_CAP_STROOPS - committedStroops;

  return {
    committedStroops,
    availableStroops,
    capStroops: SPONSORSHIP_CAP_STROOPS,
    activeCount: active.length,
    exhausted: availableStroops < SPONSORSHIP_PER_ACCOUNT_STROOPS,
    reclaimableCount,
    durable: isDurable(),
  };
}

/**
 * Reserves capacity for a new sponsorship.
 *
 * Written *before* the transaction is submitted, deliberately. Reserving after
 * submission would leave a window in which concurrent requests each see
 * headroom that is about to be consumed, and the cap would be exceeded by
 * however many requests fit in that window. Reserving first means the ledger is
 * pessimistic — a submission that then fails leaves a stale reservation, which
 * `releaseFailedReservation` cleans up and which errs toward under-spending.
 *
 * Returns null when the cap has no room.
 */
export async function reserveCapacity(
  account: string,
  sponsoredBy: string,
  now: number = Date.now(),
): Promise<SponsorshipRecord | null> {
  const existing = await getSponsorship(account);
  if (existing && existing.status === "active") {
    // Already sponsored — idempotent, and must not lock a second reserve.
    return existing;
  }

  const capacity = await getCapacity(now);
  if (capacity.exhausted) return null;

  const record: SponsorshipRecord = {
    account,
    lockedStroops: SPONSORSHIP_PER_ACCOUNT_STROOPS.toString(),
    status: "active",
    createdAt: now,
    lastActiveAt: now,
    sponsoredBy,
    revokedAt: null,
  };

  const client = isDurable() ? createServiceRoleClient() : null;
  if (client) {
    const { error } = await client.from(TABLE).upsert(
      {
        account: record.account,
        locked_stroops: record.lockedStroops,
        status: record.status,
        created_at_ms: record.createdAt,
        last_active_at_ms: record.lastActiveAt,
        sponsored_by: record.sponsoredBy,
        revoked_at_ms: null,
      },
      { onConflict: "account" },
    );
    if (error) throw new Error(`Sponsorship ledger write failed: ${error.message}`);
    return record;
  }

  memoryLedger.set(account, record);
  return record;
}

/** Drops a reservation whose transaction never landed. */
export async function releaseFailedReservation(account: string): Promise<void> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { error } = await client.from(TABLE).delete().eq("account", account).eq("status", "active");
    if (error) throw new Error(`Sponsorship ledger cleanup failed: ${error.message}`);
    return;
  }

  memoryLedger.delete(account);
}

/** Marks a sponsorship released, freeing its share of the cap. */
export async function markRevoked(
  account: string,
  now: number = Date.now(),
): Promise<void> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    const { error } = await client
      .from(TABLE)
      .update({ status: "revoked", revoked_at_ms: now })
      .eq("account", account);
    if (error) throw new Error(`Sponsorship ledger update failed: ${error.message}`);
    return;
  }

  const record = memoryLedger.get(account);
  if (record) {
    memoryLedger.set(account, { ...record, status: "revoked", revokedAt: now });
  }
}

/** Records activity, which defers idle reclamation. */
export async function touchActivity(account: string, now: number = Date.now()): Promise<void> {
  const client = isDurable() ? createServiceRoleClient() : null;

  if (client) {
    await client.from(TABLE).update({ last_active_at_ms: now }).eq("account", account);
    return;
  }

  const record = memoryLedger.get(account);
  if (record) memoryLedger.set(account, { ...record, lastActiveAt: now });
}

/** Sponsorships idle past the reclaim window — candidates for revocation. */
export async function listReclaimable(now: number = Date.now()): Promise<SponsorshipRecord[]> {
  const active = await listActiveSponsorships();
  return active.filter((r) => now - r.lastActiveAt > SPONSORSHIP_IDLE_RECLAIM_MS);
}

/** Test seam. */
export function resetMemoryLedger(): void {
  memoryLedger.clear();
}
