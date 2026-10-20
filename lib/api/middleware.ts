import { NextRequest, NextResponse } from "next/server";
import { type ApiScope, type AuditLogEntry, type ScopedTokenPayload } from "./types";
import { verifyScopedToken } from "./tokens";
import { checkRateLimit, getClientIp } from "@/lib/auth/rateLimiter";

export interface AuthenticatedContext {
  tokenPayload: ScopedTokenPayload;
  ip: string;
  userAgent: string;
  idempotencyKey: string | null;
}

interface IdempotentCachedResponse {
  statusCode: number;
  body: string;
  headers: Record<string, string>;
  createdAt: number;
}

declare global {
  var stellarStarAuditLogs: AuditLogEntry[] | undefined;
  var stellarStarIdempotencyCache: Map<string, IdempotentCachedResponse> | undefined;
}

const auditLogs: AuditLogEntry[] = globalThis.stellarStarAuditLogs ?? [];
globalThis.stellarStarAuditLogs = auditLogs;

const idempotencyCache =
  globalThis.stellarStarIdempotencyCache ?? new Map<string, IdempotentCachedResponse>();
globalThis.stellarStarIdempotencyCache = idempotencyCache;

const MAX_AUDIT_LOGS = 500;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

export function recordAuditLog(entry: Omit<AuditLogEntry, "id">): AuditLogEntry {
  const fullEntry: AuditLogEntry = {
    id: crypto.randomUUID(),
    ...entry,
  };
  auditLogs.unshift(fullEntry);
  if (auditLogs.length > MAX_AUDIT_LOGS) {
    auditLogs.pop();
  }
  return fullEntry;
}

export function getAuditLogsForWallet(
  walletAddress: string,
  limit = 50
): AuditLogEntry[] {
  const normalized = walletAddress.trim().toUpperCase();
  return auditLogs
    .filter((log) => log.walletAddress === normalized)
    .slice(0, Math.min(limit, 100));
}

export function clearAuditLogs(): void {
  auditLogs.length = 0;
  idempotencyCache.clear();
}

/**
 * Validates developer authentication, permissions, rate limits, and idempotency.
 */
export async function authenticateApiRequest(
  request: NextRequest,
  options: {
    requiredScopes?: ApiScope[];
    rateLimitMax?: number;
    rateLimitWindowMs?: number;
  } = {}
): Promise<
  | { success: true; context: AuthenticatedContext }
  | { success: false; response: NextResponse }
> {
  const ip = getClientIp(request);
  const userAgent = request.headers.get("user-agent") || "unknown";
  const idempotencyKey = request.headers.get("idempotency-key");

  // 1. Extract Bearer token
  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: {
            code: "UNAUTHORIZED",
            message: "Missing or malformed Authorization header. Expected 'Bearer <token>'.",
            status: 401,
          },
        },
        { status: 401 }
      ),
    };
  }

  const rawToken = authHeader.slice(7).trim();
  const verification = verifyScopedToken(rawToken);

  if (!verification.valid || !verification.payload) {
    return {
      success: false,
      response: NextResponse.json(
        {
          error: {
            code: "INVALID_TOKEN",
            message: verification.error || "Invalid or revoked credentials.",
            status: 401,
          },
        },
        { status: 401 }
      ),
    };
  }

  const payload = verification.payload;

  // 2. Enforce scope authorization
  if (options.requiredScopes && options.requiredScopes.length > 0) {
    const missingScopes = options.requiredScopes.filter(
      (scope) => !payload.scopes.includes(scope)
    );

    if (missingScopes.length > 0) {
      return {
        success: false,
        response: NextResponse.json(
          {
            error: {
              code: "INSUFFICIENT_SCOPE",
              message: `Token lacks required scope(s): ${missingScopes.join(", ")}`,
              status: 403,
              details: { granted: payload.scopes, required: options.requiredScopes },
            },
          },
          { status: 403 }
        ),
      };
    }
  }

  // 3. Enforce rate limiting
  const rateLimitMax = options.rateLimitMax ?? 60;
  const rateLimitWindowMs = options.rateLimitWindowMs ?? 60_000;
  const rateLimitKey = `api:rate:${payload.tokenId}:${ip}`;

  const rateResult = await checkRateLimit(rateLimitKey, rateLimitMax, rateLimitWindowMs);

  if (!rateResult.allowed) {
    const retryAfter = Math.ceil(rateResult.resetMs / 1000);
    return {
      success: false,
      response: NextResponse.json(
        {
          error: {
            code: "RATE_LIMIT_EXCEEDED",
            message: "Too many requests. Please slow down and try again.",
            status: 429,
          },
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(rateLimitMax),
            "X-RateLimit-Remaining": "0",
            "X-RateLimit-Reset": String(Date.now() + rateResult.resetMs),
          },
        }
      ),
    };
  }

  return {
    success: true,
    context: {
      tokenPayload: payload,
      ip,
      userAgent,
      idempotencyKey,
    },
  };
}

/** Checks if an idempotent replay is available. */
export function getIdempotentResponse(
  walletAddress: string,
  idempotencyKey: string | null
): NextResponse | null {
  if (!idempotencyKey) return null;
  const cacheKey = `${walletAddress}:${idempotencyKey}`;
  const cached = idempotencyCache.get(cacheKey);

  if (!cached) return null;

  if (Date.now() - cached.createdAt > IDEMPOTENCY_TTL_MS) {
    idempotencyCache.delete(cacheKey);
    return null;
  }

  const headers = new Headers(cached.headers);
  headers.set("Idempotent-Replayed", "true");

  return new NextResponse(cached.body, {
    status: cached.statusCode,
    headers,
  });
}

/** Stores an idempotent response in the replay cache. */
export function storeIdempotentResponse(
  walletAddress: string,
  idempotencyKey: string | null,
  statusCode: number,
  body: unknown,
  extraHeaders: Record<string, string> = {}
): void {
  if (!idempotencyKey) return;
  const cacheKey = `${walletAddress}:${idempotencyKey}`;
  const serializedBody = typeof body === "string" ? body : JSON.stringify(body);

  idempotencyCache.set(cacheKey, {
    statusCode,
    body: serializedBody,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    createdAt: Date.now(),
  });
}
