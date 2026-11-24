import crypto from "crypto";
import {
  type WebhookEndpoint,
  type WebhookEventName,
  type WebhookDeliveryLog,
} from "./types";
import { createServiceRoleClient } from "@/lib/supabase/server";

const WEBHOOK_SECRET_PREFIX = "whsec_";
const MAX_DELIVERY_LOGS = 200;
const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes
const MAX_ATTEMPTS = 8;

/** Enqueue matching deliveries durably; event ids deduplicate producer retries. */
export async function enqueueWebhookEvent(args: {
  id: string; event: WebhookEventName; data: Record<string, unknown>; walletAddress?: string;
}): Promise<number> {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook delivery requires SUPABASE_SERVICE_ROLE_KEY.");
  const db = client as any;
  let query = db.from("webhook_endpoints").select("id,events").eq("active", true);
  if (args.walletAddress) query = query.eq("wallet_address", args.walletAddress.trim().toUpperCase());
  const { data: endpoints, error } = await query;
  if (error) throw new Error("Unable to load webhook subscriptions.");
  const matching = (endpoints ?? []).filter((ep: any) => ep.events.includes(args.event) || ep.events.includes("ping"));
  if (!matching.length) return 0;
  const payload = { id: args.id, event: args.event, timestamp: new Date().toISOString(), data: args.data };
  const rows = matching.map((ep: any) => ({ id: args.id, endpoint_id: ep.id, event: args.event, payload }));
  const { error: insertError } = await db.from("webhook_outbox").upsert(rows, { onConflict: "endpoint_id,id", ignoreDuplicates: true });
  if (insertError) throw new Error("Unable to enqueue webhook deliveries.");
  return matching.length;
}

/** Process one bounded batch claimed with SKIP LOCKED by PostgreSQL. */
export async function processWebhookOutbox(limit = 10): Promise<number> {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook delivery requires SUPABASE_SERVICE_ROLE_KEY.");
  const db = client as any;
  const { data: jobs, error } = await db.rpc("claim_webhook_deliveries", { p_limit: Math.min(10, Math.max(1, limit)) });
  if (error) throw new Error("Unable to claim webhook deliveries.");
  let processed = 0;
  for (const job of jobs ?? []) {
    const { data: endpoint } = await db.from("webhook_endpoints").select("url,secret,active").eq("id", job.endpoint_id).maybeSingle();
    let statusCode: number | null = null;
    let failure = "Endpoint unavailable.";
    if (endpoint?.active) {
      try {
        const payloadString = JSON.stringify(job.payload);
        const timestamp = Math.floor(Date.now() / 1000);
        const signature = signWebhookPayload(payloadString, endpoint.secret, timestamp);
        const response = await fetch(endpoint.url, { method: "POST", headers: { "Content-Type": "application/json", "Stellar-Signature": signature, "Stellar-Event": job.event, "Stellar-Delivery": job.id, "User-Agent": "StellarStar-Webhooks/1.0" }, body: payloadString, signal: AbortSignal.timeout(5000), redirect: "error" });
        statusCode = response.status;
        if (response.ok) {
          await db.from("webhook_outbox").update({ status: "delivered", delivered_at: new Date().toISOString(), locked_until: null, status_code: statusCode, last_error: null }).eq("id", job.id).eq("endpoint_id", job.endpoint_id);
          await db.from("webhook_endpoints").update({ consecutive_failures: 0 }).eq("id", job.endpoint_id);
          processed++; continue;
        }
        failure = `HTTP ${statusCode}`;
      } catch (error) { failure = error instanceof Error ? error.name : "NetworkError"; }
    }
    const terminal = job.attempts >= MAX_ATTEMPTS;
    const backoff = Math.min(3600, 2 ** Math.max(0, job.attempts - 1) * 30);
    const jitteredSeconds = Math.round(backoff * (0.5 + Math.random()));
    await db.from("webhook_outbox").update({ status: terminal ? "dead" : "pending", next_attempt_at: new Date(Date.now() + jitteredSeconds * 1000).toISOString(), locked_until: null, status_code: statusCode, last_error: failure }).eq("id", job.id).eq("endpoint_id", job.endpoint_id);
    await db.rpc("record_webhook_failure", { p_endpoint_id: job.endpoint_id });
    processed++;
  }
  return processed;
}

export async function listDurableWebhookDeliveries(walletAddress: string, limit = 50) {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook diagnostics require SUPABASE_SERVICE_ROLE_KEY.");
  const { data, error } = await (client as any).from("webhook_outbox")
    .select("id,endpoint_id,event,status,attempts,status_code,last_error,created_at,delivered_at,webhook_endpoints!inner(wallet_address)")
    .eq("webhook_endpoints.wallet_address", walletAddress.trim().toUpperCase())
    .order("created_at", { ascending: false }).limit(Math.min(100, Math.max(1, limit)));
  if (error) throw new Error("Unable to load webhook diagnostics.");
  return (data ?? []).map((row: any) => ({ id: row.id, webhookId: row.endpoint_id, event: row.event, status: row.status, attempt: row.attempts, statusCode: row.status_code, error: row.last_error, timestamp: row.created_at, deliveredAt: row.delivered_at }));
}

declare global {
  var stellarStarWebhookEndpoints: Map<string, WebhookEndpoint> | undefined;
  var stellarStarDeliveryLogs: WebhookDeliveryLog[] | undefined;
}

const webhookEndpoints =
  globalThis.stellarStarWebhookEndpoints ?? new Map<string, WebhookEndpoint>();
globalThis.stellarStarWebhookEndpoints = webhookEndpoints;

const deliveryLogs: WebhookDeliveryLog[] =
  globalThis.stellarStarDeliveryLogs ?? [];
globalThis.stellarStarDeliveryLogs = deliveryLogs;

export function generateWebhookSecret(): string {
  return `${WEBHOOK_SECRET_PREFIX}${crypto.randomBytes(24).toString("hex")}`;
}

export async function createDurableWebhookEndpoint(input: { walletAddress: string; url: string; events: WebhookEventName[]; description?: string }) {
  if (!isValidWebhookUrl(input.url) || !isPublicWebhookHost(input.url)) throw new Error("Invalid webhook URL. Must use a public HTTPS host.");
  if (!input.events?.length || input.events.length > 8) throw new Error("Webhook must subscribe to 1-8 events.");
  if (input.url.length > 2048 || (input.description?.length ?? 0) > 256) throw new Error("Webhook URL or description exceeds its size limit.");
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook management requires SUPABASE_SERVICE_ROLE_KEY.");
  const db = client as any;
  const { count, error: countError } = await db.from("webhook_endpoints").select("id", { count: "exact", head: true }).eq("wallet_address", input.walletAddress.trim().toUpperCase());
  if (countError) throw new Error("Unable to validate webhook endpoint limit.");
  if ((count ?? 0) >= 20) throw new Error("A wallet may register at most 20 webhook endpoints.");
  const allowed = new Set(["trip.created", "trip.updated", "expense.created", "expense.updated", "settlement.started", "settlement.completed", "settlement.failed", "ping"]);
  if (input.events.some((event) => !allowed.has(event))) throw new Error("Webhook contains an unsupported event.");
  const secret = generateWebhookSecret();
  const { data, error } = await db.from("webhook_endpoints").insert({ wallet_address: input.walletAddress.trim().toUpperCase(), url: input.url.trim(), events: input.events, description: input.description?.trim() || null, secret }).select("id,wallet_address,url,events,description,active,created_at").single();
  if (error || !data) throw new Error("Unable to create webhook endpoint.");
  return { id: data.id, walletAddress: data.wallet_address, url: data.url, events: data.events, description: data.description ?? undefined, active: data.active, createdAt: data.created_at, secret };
}

function isPublicWebhookHost(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" || !url.hostname.includes(".") || url.hostname.endsWith(".local") || url.hostname.endsWith(".internal")) return false;
    if (url.hostname.startsWith("[")) return false;
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const octets = host.split(".").map(Number);
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
    const [a, b] = octets;
    return !(a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224);
  } catch { return false; }
}

export async function listDurableWebhookEndpoints(walletAddress: string) {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook management requires SUPABASE_SERVICE_ROLE_KEY.");
  const { data, error } = await (client as any).from("webhook_endpoints").select("id,wallet_address,url,events,description,active,created_at").eq("wallet_address", walletAddress.trim().toUpperCase()).order("created_at", { ascending: false });
  if (error) throw new Error("Unable to list webhook endpoints.");
  return (data ?? []).map((row: any) => ({ id: row.id, walletAddress: row.wallet_address, url: row.url, events: row.events, description: row.description ?? undefined, active: row.active, createdAt: row.created_at }));
}

export async function enqueueDurableWebhookPing(webhookId: string, walletAddress: string) {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook management requires SUPABASE_SERVICE_ROLE_KEY.");
  const { data, error } = await (client as any).from("webhook_endpoints").select("id").eq("id", webhookId).eq("wallet_address", walletAddress.trim().toUpperCase()).eq("active", true).maybeSingle();
  if (error || !data) throw new Error("Webhook endpoint not found or unauthorized.");
  const id = crypto.randomUUID();
  const payload = { id, event: "ping", timestamp: new Date().toISOString(), data: { message: "Test webhook delivery from StellarStar Developer Platform", webhookId } };
  const { error: enqueueError } = await (client as any).from("webhook_outbox").insert({ id, endpoint_id: webhookId, event: "ping", payload });
  if (enqueueError) throw new Error("Unable to enqueue webhook test delivery.");
  return { id, webhookId, event: "ping", status: "pending", attempt: 0, timestamp: new Date().toISOString() };
}

export async function deleteDurableWebhookEndpoint(id: string, walletAddress: string) {
  const client = createServiceRoleClient();
  if (!client) throw new Error("Webhook management requires SUPABASE_SERVICE_ROLE_KEY.");
  const { data, error } = await (client as any).from("webhook_endpoints").delete().eq("id", id).eq("wallet_address", walletAddress.trim().toUpperCase()).select("id").maybeSingle();
  if (error) throw new Error("Unable to delete webhook endpoint.");
  return Boolean(data);
}

export function isValidWebhookUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol === "https:") return true;
    if (
      parsed.protocol === "http:" &&
      (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1")
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * Computes the HMAC-SHA256 signature for a webhook payload.
 * Format: t=<timestamp>,v1=<hex_signature>
 */
export function signWebhookPayload(
  payloadString: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000)
): string {
  const signaturePayload = `${timestamp}.${payloadString}`;
  const hmac = crypto
    .createHmac("sha256", secret)
    .update(signaturePayload)
    .digest("hex");
  return `t=${timestamp},v1=${hmac}`;
}

/**
 * Verifies the webhook signature and guards against replay attacks.
 */
export function verifyWebhookSignature(
  payloadString: string,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS
): { valid: boolean; error?: string } {
  if (!signatureHeader) {
    return { valid: false, error: "Missing signature header." };
  }

  const parts = signatureHeader.split(",");
  const timePart = parts.find((p) => p.startsWith("t="));
  const sigPart = parts.find((p) => p.startsWith("v1="));

  if (!timePart || !sigPart) {
    return { valid: false, error: "Malformed signature header format." };
  }

  const timestamp = parseInt(timePart.slice(2), 10);
  const signature = sigPart.slice(3);

  if (isNaN(timestamp)) {
    return { valid: false, error: "Invalid timestamp in signature." };
  }

  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, error: "Webhook timestamp outside tolerance window (replay protection)." };
  }

  const expectedSig = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payloadString}`)
    .digest("hex");

  const bufSig = Buffer.from(signature);
  const bufExpected = Buffer.from(expectedSig);

  if (bufSig.length !== bufExpected.length || !crypto.timingSafeEqual(bufSig, bufExpected)) {
    return { valid: false, error: "Signature mismatch." };
  }

  return { valid: true };
}

/**
 * Registers a new webhook endpoint for a wallet.
 */
export function registerWebhookEndpoint({
  walletAddress,
  url,
  events,
  description,
}: {
  walletAddress: string;
  url: string;
  events: WebhookEventName[];
  description?: string;
}): WebhookEndpoint {
  if (!isValidWebhookUrl(url)) {
    throw new Error("Invalid webhook URL. Must use HTTPS (or localhost in development).");
  }

  if (!events || events.length === 0) {
    throw new Error("Webhook must subscribe to at least one event.");
  }

  const id = crypto.randomUUID();
  const secret = generateWebhookSecret();
  const normalizedWallet = walletAddress.trim().toUpperCase();

  const endpoint: WebhookEndpoint = {
    id,
    walletAddress: normalizedWallet,
    url: url.trim(),
    secret,
    events,
    active: true,
    createdAt: new Date().toISOString(),
    description: description?.trim(),
  };

  webhookEndpoints.set(id, endpoint);
  return endpoint;
}

export function listWebhooksForWallet(walletAddress: string): WebhookEndpoint[] {
  const normalized = walletAddress.trim().toUpperCase();
  const results: WebhookEndpoint[] = [];
  for (const ep of webhookEndpoints.values()) {
    if (ep.walletAddress === normalized) {
      results.push({ ...ep });
    }
  }
  return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function deleteWebhookEndpoint(id: string, walletAddress: string): boolean {
  const normalized = walletAddress.trim().toUpperCase();
  const ep = webhookEndpoints.get(id);
  if (!ep || ep.walletAddress !== normalized) {
    return false;
  }
  return webhookEndpoints.delete(id);
}

/**
 * Dispatches an event to all matching registered webhook endpoints.
 * Handles signatures, delivery logging, and retries.
 */
export async function dispatchWebhookEvent({
  event,
  data,
  walletAddress,
  maxRetries = 2,
}: {
  event: WebhookEventName;
  data: Record<string, unknown>;
  walletAddress?: string;
  maxRetries?: number;
}): Promise<WebhookDeliveryLog[]> {
  const matchingEndpoints: WebhookEndpoint[] = [];
  const normalizedWallet = walletAddress ? walletAddress.trim().toUpperCase() : null;

  for (const ep of webhookEndpoints.values()) {
    if (!ep.active) continue;
    if (normalizedWallet && ep.walletAddress !== normalizedWallet) continue;
    if (ep.events.includes(event) || ep.events.includes("ping")) {
      matchingEndpoints.push(ep);
    }
  }

  const results: WebhookDeliveryLog[] = [];

  for (const ep of matchingEndpoints) {
    const deliveryId = crypto.randomUUID();
    const eventPayload = {
      id: deliveryId,
      event,
      timestamp: new Date().toISOString(),
      data,
    };
    const payloadString = JSON.stringify(eventPayload);
    const signature = signWebhookPayload(payloadString, ep.secret);

    let attempt = 1;
    let success = false;
    let statusCode: number | null = null;
    let error: string | null = null;
    const startTime = Date.now();

    while (attempt <= maxRetries && !success) {
      try {
        const response = await fetch(ep.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Stellar-Signature": signature,
            "Stellar-Event": event,
            "Stellar-Delivery": deliveryId,
            "User-Agent": "StellarStar-Webhooks/1.0",
          },
          body: payloadString,
          signal: AbortSignal.timeout(5000),
        });

        statusCode = response.status;
        if (response.ok) {
          success = true;
          error = null;
          break;
        } else {
          error = `HTTP error status ${response.status}`;
        }
      } catch (err: unknown) {
        error = err instanceof Error ? err.message : "Network error";
      }

      attempt++;
      if (!success && attempt <= maxRetries) {
        // Exponential backoff
        await new Promise((r) => setTimeout(r, attempt * 50));
      }
    }

    const logEntry: WebhookDeliveryLog = {
      id: deliveryId,
      webhookId: ep.id,
      event,
      payload: eventPayload,
      statusCode,
      attempt: Math.min(attempt, maxRetries),
      latencyMs: Date.now() - startTime,
      success,
      error,
      timestamp: new Date().toISOString(),
      signature,
    };

    deliveryLogs.unshift(logEntry);
    if (deliveryLogs.length > MAX_DELIVERY_LOGS) {
      deliveryLogs.pop();
    }
    results.push(logEntry);
  }

  return results;
}

/**
 * Sends a test ping event to a specific webhook endpoint.
 */
export async function sendTestWebhookPing(
  webhookId: string,
  walletAddress: string
): Promise<WebhookDeliveryLog> {
  const normalized = walletAddress.trim().toUpperCase();
  const ep = webhookEndpoints.get(webhookId);
  if (!ep || ep.walletAddress !== normalized) {
    throw new Error("Webhook endpoint not found or unauthorized.");
  }

  const logs = await dispatchWebhookEvent({
    event: "ping",
    data: {
      message: "Test webhook delivery from StellarStar Developer Platform",
      timestamp: new Date().toISOString(),
      webhookId,
    },
    walletAddress: normalized,
    maxRetries: 1,
  });

  return (
    logs[0] ?? {
      id: crypto.randomUUID(),
      webhookId,
      event: "ping",
      payload: {},
      statusCode: null,
      attempt: 1,
      latencyMs: 0,
      success: false,
      error: "Delivery failed to initiate",
      timestamp: new Date().toISOString(),
      signature: "",
    }
  );
}

export function getDeliveryLogsForWallet(
  walletAddress: string,
  limit = 50
): WebhookDeliveryLog[] {
  const endpoints = listWebhooksForWallet(walletAddress);
  const endpointIds = new Set(endpoints.map((ep) => ep.id));

  return deliveryLogs
    .filter((log) => endpointIds.has(log.webhookId))
    .slice(0, Math.min(limit, 100));
}

export function clearWebhookStore(): void {
  webhookEndpoints.clear();
  deliveryLogs.length = 0;
}
