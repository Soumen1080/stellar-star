import crypto from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { checkRateLimit, getClientIp, type RateLimitResult } from "@/lib/auth/rateLimiter";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import { recordSecurityEvent, redactSecurityIdentifier } from "./securityEvents";
import type { AbuseScope, PublicRateLimitPolicy, RateLimitPolicy } from "@/types/security";

const MIN_RETRY_SECONDS = 1;
const POW_DIFFICULTY = 3;
const CHALLENGE_TTL_MS = 5 * 60_000;

/** Published, conservative budgets. Limits include short retry bursts so settlement retries remain usable. */
export const ABUSE_POLICIES: Record<AbuseScope, PublicRateLimitPolicy> = {
  "auth.challenge": { ip: { limit: 40, windowMs: 60_000 }, wallet: { limit: 12, windowMs: 60_000 }, endpoint: { limit: 160, windowMs: 60_000 }, challengeAfterBlocks: 2 },
  "auth.verify": { ip: { limit: 25, windowMs: 5 * 60_000 }, wallet: { limit: 12, windowMs: 5 * 60_000 }, endpoint: { limit: 100, windowMs: 5 * 60_000 }, challengeAfterBlocks: 2 },
  "auth.refresh": { ip: { limit: 60, windowMs: 60_000 }, wallet: { limit: 20, windowMs: 60_000 }, endpoint: { limit: 240, windowMs: 60_000 } },
  "invitation.create": { ip: { limit: 30, windowMs: 15 * 60_000 }, wallet: { limit: 12, windowMs: 15 * 60_000 }, endpoint: { limit: 100, windowMs: 15 * 60_000 } },
  "invitation.claim": { ip: { limit: 30, windowMs: 10 * 60_000 }, wallet: { limit: 10, windowMs: 10 * 60_000 }, endpoint: { limit: 120, windowMs: 10 * 60_000 }, challengeAfterBlocks: 2 },
  "invitation.verify": { ip: { limit: 60, windowMs: 10 * 60_000 }, endpoint: { limit: 240, windowMs: 10 * 60_000 }, challengeAfterBlocks: 2 },
  "invitation.revoke": { ip: { limit: 30, windowMs: 10 * 60_000 }, wallet: { limit: 12, windowMs: 10 * 60_000 }, endpoint: { limit: 100, windowMs: 10 * 60_000 } },
  "receipt.upload": { ip: { limit: 30, windowMs: 15 * 60_000 }, wallet: { limit: 12, windowMs: 15 * 60_000 }, endpoint: { limit: 100, windowMs: 15 * 60_000 } },
  "reminder.send": { ip: { limit: 30, windowMs: 60 * 60_000 }, wallet: { limit: 12, windowMs: 60 * 60_000 }, endpoint: { limit: 120, windowMs: 60 * 60_000 } },
  "payment.intent": { ip: { limit: 60, windowMs: 5 * 60_000 }, wallet: { limit: 24, windowMs: 5 * 60_000 }, endpoint: { limit: 240, windowMs: 5 * 60_000 }, challengeAfterBlocks: 3 },
  "idempotency.key": { ip: { limit: 60, windowMs: 15 * 60_000 }, wallet: { limit: 30, windowMs: 15 * 60_000 }, endpoint: { limit: 120, windowMs: 15 * 60_000 } },
};

function retryHeaders(limit: RateLimitPolicy, result: RateLimitResult, requestId: string): Record<string, string> {
  const retry = Math.max(MIN_RETRY_SECONDS, Math.ceil(result.resetMs / 1000));
  return {
    "Cache-Control": "no-store",
    "Retry-After": String(retry),
    "RateLimit-Limit": String(limit.limit),
    "RateLimit-Remaining": String(Math.max(0, result.remaining)),
    "RateLimit-Reset": String(Math.ceil((Date.now() + result.resetMs) / 1000)),
    [REQUEST_ID_HEADER]: requestId,
  };
}

function challengeSecret(): string {
  return process.env.ABUSE_CHALLENGE_SECRET || process.env.SUPABASE_JWT_SECRET || "development-only-abuse-challenge";
}

function createChallenge(scope: AbuseScope, ipHash: string): string {
  const payload = Buffer.from(JSON.stringify({ s: scope, i: ipHash, e: Date.now() + CHALLENGE_TTL_MS, n: crypto.randomUUID() })).toString("base64url");
  const sig = crypto.createHmac("sha256", challengeSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}

function hasValidChallenge(request: NextRequest, scope: AbuseScope, ipHash: string): boolean {
  const value = request.headers.get("x-abuse-challenge");
  if (!value) return false;
  const [token, counter] = value.split(":");
  if (!token || !counter || !/^\d{1,12}$/.test(counter)) return false;
  const [payload, sig] = token.split(".");
  if (!payload || !sig) return false;
  const expected = crypto.createHmac("sha256", challengeSecret()).update(payload).digest("base64url");
  if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.s === scope && parsed.i === ipHash && Number.isSafeInteger(parsed.e) && parsed.e > Date.now()
      && crypto.createHash("sha256").update(`${token}:${counter}`).digest("hex").startsWith("0".repeat(POW_DIFFICULTY));
  } catch { return false; }
}

export type AbuseProtectionResult = { ok: true; requestId: string } | { ok: false; response: NextResponse };

/**
 * Enforces IP, wallet and endpoint budgets before expensive work. A proof of work is
 * requested only after repeated blocks; it complements, never replaces, endpoint authorization.
 */
export async function enforceAbuseProtection(request: NextRequest, scope: AbuseScope, wallet?: string | null): Promise<AbuseProtectionResult> {
  const policy = ABUSE_POLICIES[scope];
  const ip = getClientIp(request);
  const ipHash = redactSecurityIdentifier(ip) ?? "unknown";
  const requestId = getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const dimensions: Array<[string, RateLimitPolicy]> = [[`abuse:${scope}:ip:${ipHash}`, policy.ip], [`abuse:${scope}:endpoint`, policy.endpoint]];
  const walletHash = redactSecurityIdentifier(wallet);
  if (walletHash && policy.wallet) dimensions.splice(1, 0, [`abuse:${scope}:wallet:${walletHash}`, policy.wallet]);

  for (const [key, limit] of dimensions) {
    const result = await checkRateLimit(key, limit.limit, limit.windowMs);
    if (result.allowed) continue;
    const blocks = await checkRateLimit(`abuse:block:${scope}:${ipHash}`, 3, 5 * 60_000);
    const validChallenge = hasValidChallenge(request, scope, ipHash);
    const challengeRequired = Boolean(policy.challengeAfterBlocks && blocks.count >= policy.challengeAfterBlocks && !validChallenge);
    const event = blocks.count >= 3 ? "rate_limit_alert" : "rate_limit_blocked";
    void recordSecurityEvent({ event, scope, ipHash, walletHash, endpoint: request.nextUrl.pathname, requestId, metadata: { dimension: key.split(":")[2], count: result.count, challengeRequired } });
    if (scope === "invitation.verify") void recordSecurityEvent({ event: "enumeration_suspected", scope, ipHash, endpoint: request.nextUrl.pathname, requestId, metadata: { count: result.count } });
    // Proof-of-work is deliberately a narrow, temporary relief valve after a block.
    // Authenticated routes still require their wallet JWT and service-level permission checks.
    if (validChallenge) {
      void recordSecurityEvent({ event: "suspicious_retry", scope, ipHash, walletHash, endpoint: request.nextUrl.pathname, requestId, metadata: { challenged: true } });
      continue;
    }
    const body: Record<string, unknown> = { error: "Request rate limit reached. Wait before retrying.", code: "RATE_LIMITED", retryAfterSeconds: Math.max(MIN_RETRY_SECONDS, Math.ceil(result.resetMs / 1000)), requestId };
    if (challengeRequired) body.challenge = { type: "hashcash", token: createChallenge(scope, ipHash), difficulty: POW_DIFFICULTY, header: "X-Abuse-Challenge", note: "Solve token:counter, then retry. This does not authenticate or authorize the request." };
    return { ok: false, response: NextResponse.json(body, { status: 429, headers: retryHeaders(limit, result, requestId) }) };
  }
  return { ok: true, requestId };
}

/** Independently caps creation of new idempotency keys; replays do not consume this budget. */
export async function enforceIdempotencyKeyLimit(request: NextRequest, wallet: string, key: string | null): Promise<AbuseProtectionResult> {
  if (!key) return { ok: true, requestId: getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER)) };
  return enforceAbuseProtection(request, "idempotency.key", wallet);
}
