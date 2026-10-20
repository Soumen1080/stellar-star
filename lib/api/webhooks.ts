import crypto from "crypto";
import {
  type WebhookEndpoint,
  type WebhookEventName,
  type WebhookDeliveryLog,
} from "./types";

const WEBHOOK_SECRET_PREFIX = "whsec_";
const MAX_DELIVERY_LOGS = 200;
const SIGNATURE_TOLERANCE_SECONDS = 300; // 5 minutes

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
