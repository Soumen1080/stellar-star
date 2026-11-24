/**
 * Per-user and per-trip OCR quota enforcement.
 *
 * Quotas use a sliding-window count: "at most N jobs in the last W seconds".
 * The limits come from the `ocr_quota_config` table (seeded by migration 0029)
 * so they can be tuned without a redeploy.
 *
 * Quota checks happen at enqueue time — before the file is uploaded to storage.
 * This guarantees that over-quota users never waste storage or worker capacity.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

type Client = SupabaseClient<Database>;

export class OcrQuotaError extends Error {
  readonly status: number;
  readonly retryAfterSeconds: number | null;
  constructor(message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "OcrQuotaError";
    this.status = 429;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Defaults when the config table is empty or unreachable. */
const DEFAULT_LIMITS = {
  user: { maxJobs: 20, windowSeconds: 3600 },
  trip: { maxJobs: 50, windowSeconds: 3600 },
} as const;

interface QuotaLimit {
  maxJobs: number;
  windowSeconds: number;
}

async function loadLimit(
  client: Client,
  scope: "user" | "trip",
): Promise<QuotaLimit> {
  const { data } = await client
    .from("ocr_quota_config")
    .select("max_jobs, window_seconds")
    .eq("scope", scope)
    .limit(1)
    .maybeSingle();
  if (!data) return DEFAULT_LIMITS[scope];
  return {
    maxJobs: data.max_jobs as number,
    windowSeconds: data.window_seconds as number,
  };
}

async function countRecentJobs(
  client: Client,
  column: string,
  value: string,
  windowSeconds: number,
): Promise<number> {
  const since = new Date(Date.now() - windowSeconds * 1_000).toISOString();
  const { count, error } = await client
    .from("ocr_jobs")
    .select("id", { count: "exact", head: true })
    .eq(column, value)
    .gte("created_at", since);
  if (error) return 0; // Fail open — quota enforcement should not block uploads.
  return count ?? 0;
}

/**
 * Throws `OcrQuotaError` if the wallet or trip has exceeded its OCR quota.
 */
export async function checkQuota(
  client: Client,
  { wallet, tripId }: { wallet: string; tripId: string | null },
): Promise<void> {
  // ── Per-user quota ───────────────────────────────────────────────────
  const userLimit = await loadLimit(client, "user");
  const userJobs = await countRecentJobs(client, "wallet", wallet, userLimit.windowSeconds);
  if (userJobs >= userLimit.maxJobs) {
    throw new OcrQuotaError(
      `You have used all ${userLimit.maxJobs} OCR scans for this period. ` +
      `Try again later or enter the receipt fields manually.`,
      Math.ceil(userLimit.windowSeconds / 4),
    );
  }

  // ── Per-trip quota ───────────────────────────────────────────────────
  if (tripId) {
    const tripLimit = await loadLimit(client, "trip");
    const tripJobs = await countRecentJobs(client, "trip_id", tripId, tripLimit.windowSeconds);
    if (tripJobs >= tripLimit.maxJobs) {
      throw new OcrQuotaError(
        `This trip has used all ${tripLimit.maxJobs} OCR scans for this period. ` +
        `Try again later or enter the receipt fields manually.`,
        Math.ceil(tripLimit.windowSeconds / 4),
      );
    }
  }
}

/**
 * Returns the current quota usage for display in the UI.
 */
export async function getQuotaUsage(
  client: Client,
  wallet: string,
  tripId: string | null,
): Promise<{
  user: { used: number; limit: number; windowSeconds: number };
  trip: { used: number; limit: number; windowSeconds: number } | null;
}> {
  const userLimit = await loadLimit(client, "user");
  const userJobs = await countRecentJobs(client, "wallet", wallet, userLimit.windowSeconds);

  let trip = null;
  if (tripId) {
    const tripLimit = await loadLimit(client, "trip");
    const tripJobs = await countRecentJobs(client, "trip_id", tripId, tripLimit.windowSeconds);
    trip = { used: tripJobs, limit: tripLimit.maxJobs, windowSeconds: tripLimit.windowSeconds };
  }

  return {
    user: { used: userJobs, limit: userLimit.maxJobs, windowSeconds: userLimit.windowSeconds },
    trip,
  };
}
