/**
 * lib/api/routeGuard.ts
 *
 * The one authentication guard for wallet-session API routes (#419).
 * Server only.
 *
 * Every route used to read the Authorization header, verify the session and
 * build its Supabase client itself. Small differences crept in: a
 * case-insensitive `Bearer` here, an unconditional client there, a service-role
 * client in a user path. Each one was a chance for unauthenticated or
 * over-privileged data access. Protected routes now start with:
 *
 *   const auth = authenticateWalletRequest(request);
 *   if (!auth.ok) return auth.response;
 *   const { actor, requestId } = auth.ctx;
 *   const db = auth.ctx.db();            // RLS client bound to this session
 *
 * Before any query runs, the guard:
 *   1. assigns the request ID (an incoming X-Request-Id or a new one);
 *   2. parses the bearer token strictly: the `Bearer` scheme, one token,
 *      JWT charset, at most 4 KiB;
 *   3. verifies the wallet session (signature, algorithm, expiry, wallet claim);
 *   4. attaches the actor (wallet, subject) and request context;
 *   5. offers only the session's RLS-scoped client. The service-role client is
 *      not reachable from here. __tests__/security/routeGuards.test.ts fails
 *      CI if a user-request route imports it outside the documented
 *      privileged inventory (docs/AUTHORIZATION_MATRIX.md §4.2).
 *
 * Every refusal is the same 401 `{ error, code: "AUTH_REQUIRED", requestId }`
 * with `WWW-Authenticate: Bearer` and `Cache-Control: no-store`. A missing,
 * malformed, forged and expired token are indistinguishable to the client.
 */

import { NextResponse } from "next/server";
import { verifyWalletSession, type WalletSessionClaims } from "@/lib/supabase/serverAuth";
import {
  createServerClientForToken,
  isServerSupabaseConfigured,
  type ServerClient,
} from "@/lib/supabase/server";
import { getOrCreateRequestId, REQUEST_ID_HEADER } from "@/lib/observability/requestId";

export const AUTH_REQUIRED_CODE = "AUTH_REQUIRED";
export const DEFAULT_UNAUTHORIZED_MESSAGE = "Unauthorized: Sign in with your wallet.";
const MAX_TOKEN_LENGTH = 4096;
const TOKEN_RE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;

export interface WalletActor {
  kind: "wallet";
  /** Verified wallet address from the session's `wallet_address` claim. */
  wallet: string;
  /** The session's `sub` claim. */
  subject: string;
}

export interface WalletRouteContext {
  requestId: string;
  actor: WalletActor;
  claims: WalletSessionClaims;
  /** The verified bearer token, for helpers that bind their own RLS client. */
  token: string;
  /** RLS client bound to this session. Created on first use, then reused. */
  db(): ServerClient;
  /** `db()`, or null when the server database is not configured (dev/test fallbacks). */
  dbIfConfigured(): ServerClient | null;
}

export type GuardResult =
  | { ok: true; ctx: WalletRouteContext }
  | { ok: false; response: NextResponse };

interface RequestLike {
  headers: { get(name: string): string | null };
}

/**
 * Extracts the bearer token, or null when the header is missing or does not
 * match the strict format. Never throws.
 */
export function readBearerToken(headers: RequestLike["headers"]): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer[ ]+(\S+)[ ]*$/.exec(header);
  if (!match) return null;
  const token = match[1];
  if (token.length > MAX_TOKEN_LENGTH || !TOKEN_RE.test(token)) return null;
  return token;
}

export function unauthorizedResponse(requestId: string, message = DEFAULT_UNAUTHORIZED_MESSAGE): NextResponse {
  return NextResponse.json(
    { error: message, code: AUTH_REQUIRED_CODE, requestId },
    {
      status: 401,
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="stellar-star"',
        [REQUEST_ID_HEADER]: requestId,
      },
    },
  );
}

function buildContext(token: string, claims: WalletSessionClaims, requestId: string): WalletRouteContext {
  let client: ServerClient | null = null;
  const db = () => {
    client ??= createServerClientForToken(token);
    return client;
  };
  return {
    requestId,
    actor: { kind: "wallet", wallet: claims.wallet_address, subject: claims.sub },
    claims,
    token,
    db,
    dbIfConfigured: () => (isServerSupabaseConfigured() ? db() : null),
  };
}

/** Verifies the token. Returns the claims, or null for anything that does not verify. */
function verify(token: string | null): WalletSessionClaims | null {
  if (!token) return null;
  try {
    const claims = verifyWalletSession(token);
    return claims && typeof claims.wallet_address === "string" && claims.wallet_address ? claims : null;
  } catch {
    // A misconfigured secret fails closed, as an unauthenticated request.
    return null;
  }
}

/**
 * Requires a valid wallet session. Use the context's `db()` for every query;
 * it is the session's RLS-scoped client.
 */
export function authenticateWalletRequest(
  request: RequestLike,
  options: { message?: string; requestId?: string } = {},
): GuardResult {
  const requestId = options.requestId ?? getOrCreateRequestId(request.headers.get(REQUEST_ID_HEADER));
  const token = readBearerToken(request.headers);
  const claims = verify(token);
  if (!token || !claims) {
    return { ok: false, response: unauthorizedResponse(requestId, options.message) };
  }
  return { ok: true, ctx: buildContext(token, claims, requestId) };
}

/**
 * For routes that also serve anonymous callers, such as webhook re-syncs. No
 * Authorization header means anonymous (`ctx: null`). A header that is
 * present but invalid is refused with the same 401, never downgraded to
 * anonymous.
 */
export function optionalWalletSession(
  request: RequestLike,
  options: { message?: string; requestId?: string } = {},
): { ok: true; ctx: WalletRouteContext | null } | { ok: false; response: NextResponse } {
  if (!request.headers.get("authorization")) return { ok: true, ctx: null };
  return authenticateWalletRequest(request, options);
}
