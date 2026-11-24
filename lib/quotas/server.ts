import { createServiceRoleClient } from "@/lib/supabase/server";
import { serverEnv } from "@/lib/config/serverEnv";

export type TenantQuotaRequest = {
  objects?: number;
  bytes?: number;
  jobs?: number;
  events?: number;
  requests?: number;
};

export type TenantQuotaResult =
  | { available: true; allowed: boolean; metric: string | null; resetMs: number }
  | { available: false };

/** Atomically consumes one or more wallet quotas through a service-only RPC. */
export async function consumeTenantQuota(
  walletAddress: string,
  quota: TenantQuotaRequest,
  resourceId?: string,
): Promise<TenantQuotaResult> {
  const client = createServiceRoleClient();
  if (!client) {
    return serverEnv.nodeEnv === "production"
      ? { available: false }
      : { available: true, allowed: true, metric: null, resetMs: 0 };
  }
  const { data, error } = await client.rpc("consume_tenant_quotas", {
    p_wallet_address: walletAddress.trim().toUpperCase(),
    p_objects: quota.objects ?? 0,
    p_bytes: quota.bytes ?? 0,
    p_jobs: quota.jobs ?? 0,
    p_events: quota.events ?? 0,
    p_requests: quota.requests ?? 0,
    p_resource_id: resourceId ?? null,
  });
  if (error || !data || typeof data !== "object") return { available: false };
  const result = data as { allowed?: boolean; metric?: string | null; reset_ms?: number };
  if (typeof result.allowed !== "boolean") return { available: false };
  return {
    available: true,
    allowed: result.allowed,
    metric: result.metric ?? null,
    resetMs: Number(result.reset_ms) || 0,
  };
}

/** Releases object and byte usage once, by the receipt's stable resource ID. */
export async function releaseTenantStorageQuota(resourceId: string): Promise<boolean> {
  const client = createServiceRoleClient();
  if (!client) return false;
  const { data, error } = await client.rpc("release_tenant_storage_quota", { p_resource_id: resourceId });
  return !error && data === true;
}
