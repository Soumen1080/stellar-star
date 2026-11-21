/**
 * lib/idempotency/route.ts
 *
 * Route-level enforcement of required idempotency keys (Issue #412).
 *
 * Every public mutation listed in lib/idempotency/policy.ts follows the same
 * two steps:
 *
 *   1. `requireIdempotencyKey(request)` right after authentication and before
 *      any work: an absent or malformed key is answered with 400 and nothing
 *      runs.
 *   2. `runIdempotentMutation({...})` around the part of the handler that
 *      changes state. It atomically claims the key (lib/idempotency/store.ts),
 *      runs the handler once, and stores the response.
 *
 * Replay semantics:
 *   - A 2xx response is stored and replayed — same status, same JSON body,
 *     plus `Idempotent-Replayed: true` — for every later request with the same
 *     key and the same payload.
 *   - A non-2xx response (validation failure, 403, 409 state conflict, 5xx) is
 *     returned as-is and the claim is released. A failed attempt changed
 *     nothing, so the client may retry with the same key — even after fixing
 *     the payload — and the handler runs again.
 *   - Same key, different payload: 409 IDEMPOTENCY_CONFLICT.
 *   - Same key while the first request is still running: 409
 *     IDEMPOTENCY_IN_PROGRESS with Retry-After.
 *
 * Bodies are replayed as JSON. Response headers other than Cache-Control and
 * any `replayHeaders` are not stored.
 */

import { NextResponse } from "next/server";
import type { ServerClient } from "@/lib/supabase/server";
import { IDEMPOTENT_REPLAYED_HEADER, readIdempotencyKey } from "./key";
import {
  IdempotencyConflictError,
  IdempotencyKeyError,
  IdempotencyLockedError,
  withIdempotency,
} from "./store";

/**
 * `flat` is `{ error, code }`, used by the app routes. `v1` is the developer
 * API envelope `{ error: { code, message, status } }`.
 */
export type IdempotencyErrorFormat = "flat" | "v1";

interface RequestLike {
  headers: { get(name: string): string | null };
  method?: string;
  url?: string;
}

export function idempotencyErrorResponse(
  code: string,
  message: string,
  status: number,
  format: IdempotencyErrorFormat = "flat",
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const body = format === "v1" ? { error: { code, message, status } } : { error: message, code };
  return NextResponse.json(body, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders },
  });
}

export type RequiredIdempotencyKey =
  | { ok: true; key: string }
  | { ok: false; response: NextResponse };

/**
 * Validates the request's idempotency key, or returns the 400 to send.
 *
 * Pass `body` only for routes that historically accepted a JSON
 * `idempotencyKey` field; new routes accept the header only.
 */
export function requireIdempotencyKey(
  request: RequestLike,
  options: { body?: unknown; format?: IdempotencyErrorFormat } = {},
): RequiredIdempotencyKey {
  const result = readIdempotencyKey(request.headers, options.body);
  if (result.ok) return { ok: true, key: result.key };
  return {
    ok: false,
    response: idempotencyErrorResponse(result.code, result.message, 400, options.format),
  };
}

/** `"POST /api/expenses/abc/void"` — scopes a fingerprint to one method and resource. */
export function idempotencyEndpoint(request: RequestLike): string {
  const method = (request.method ?? "POST").toUpperCase();
  let pathname = "";
  try {
    pathname = request.url ? new URL(request.url).pathname : "";
  } catch {
    pathname = "";
  }
  return `${method} ${pathname}`;
}

export function isReplayableStatus(status: number): boolean {
  return status >= 200 && status < 300;
}

async function readReplayableBody(response: Response): Promise<unknown> {
  const text = await response.clone().text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // Every route in scope answers with JSON; a stray text body is kept
    // verbatim rather than dropped so the replay still carries it.
    return text;
  }
}

export function replayResponse(
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): NextResponse {
  const headers = {
    "Cache-Control": "no-store",
    ...extraHeaders,
    [IDEMPOTENT_REPLAYED_HEADER]: "true",
  };
  if (body === null && (status === 204 || status === 205)) {
    return new NextResponse(null, { status, headers });
  }
  return NextResponse.json(body, { status, headers });
}

/** Carries a non-2xx handler result out of the store so the claim is released. */
class UnreplayableOutcome extends Error {
  constructor(readonly response: Response) {
    super(`Handler returned ${response.status}; idempotency claim released.`);
    this.name = "UnreplayableOutcome";
  }
}

export interface IdempotentMutationOptions {
  /** Used to derive the endpoint (method + path) when `endpoint` is omitted. */
  request: RequestLike;
  /** A key already accepted by `requireIdempotencyKey`. */
  key: string;
  /**
   * Who the key belongs to: the authenticated wallet, or a fixed service
   * principal such as `staff:<id>`. Keys never collide across principals.
   */
  principal: string;
  /** What makes a retry "the same request". Bound into the fingerprint. */
  payload: unknown;
  /** The state-changing part of the handler. Runs at most once per key. */
  execute: () => Promise<Response>;
  /** Supabase client for the durable ledger; null/omitted uses the process-local ledger. */
  client?: ServerClient | null;
  /**
   * false keeps the stored response in the process-local ledger only. Use it
   * when the response carries a one-time secret (API token, webhook signing
   * secret) that must never be written to the database.
   */
  persist?: boolean;
  /** Overrides the derived endpoint; used to keep keys stable for older routes. */
  endpoint?: string;
  /** How long the first request holds the key before a retry may take it over. */
  leaseSeconds?: number;
  format?: IdempotencyErrorFormat;
  /** Headers to add to a replayed response (e.g. a request ID). */
  replayHeaders?: Record<string, string>;
}

/**
 * Runs `execute` at most once per (principal, key) and replays its 2xx
 * response to retries. See the file header for the full semantics.
 */
export async function runIdempotentMutation(options: IdempotentMutationOptions): Promise<Response> {
  const format = options.format ?? "flat";
  const state: { original?: Response } = {};

  try {
    const result = await withIdempotency<unknown>({
      client: options.persist === false ? null : options.client ?? null,
      key: options.key,
      walletAddress: options.principal,
      endpoint: options.endpoint ?? idempotencyEndpoint(options.request),
      payload: options.payload,
      leaseSeconds: options.leaseSeconds,
      execute: async () => {
        const response = await options.execute();
        if (!isReplayableStatus(response.status)) throw new UnreplayableOutcome(response);
        state.original = response;
        return { data: await readReplayableBody(response), status: response.status };
      },
    });

    if (!result.replayed && state.original) return state.original;
    return replayResponse(result.status, result.data, options.replayHeaders);
  } catch (err) {
    if (err instanceof UnreplayableOutcome) return err.response;
    if (err instanceof IdempotencyKeyError) {
      return idempotencyErrorResponse(err.code, err.message, 400, format);
    }
    if (err instanceof IdempotencyConflictError) {
      return idempotencyErrorResponse(err.code, err.message, 409, format);
    }
    if (err instanceof IdempotencyLockedError) {
      return idempotencyErrorResponse(err.code, err.message, 409, format, {
        "Retry-After": String(err.retryAfterSeconds),
      });
    }
    throw err;
  }
}
