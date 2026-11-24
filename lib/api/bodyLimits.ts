/**
 * lib/api/bodyLimits.ts
 *
 * Shared byte-limited request/response boundary for API routes (#418).
 *
 * Calling `request.json()` or `request.text()` buffers and parses the whole
 * body before any validation runs, so a large or deeply nested body costs
 * memory and CPU even when it is about to be rejected. Every route reads its
 * body through this module instead, which enforces, in order:
 *
 *   1. media type   application/json (or +json) for JSON routes, otherwise 415.
 *                   multipart/form-data for upload routes.
 *   2. declared     a malformed Content-Length is 400; one above the route's
 *      length       cap is 413 before a byte is read.
 *   3. streamed     the body stream is counted chunk by chunk and cancelled
 *      bytes        the moment it passes the cap: 413. A lying or absent
 *                   Content-Length does not help an attacker.
 *   4. decoding     strict UTF-8 (invalid sequences are 400), then JSON.parse
 *                   (400), then a nesting-depth limit (400).
 *   5. schema       the route's `expect` shape ("object" by default) and an
 *                   optional `validate` callback, both 400.
 *
 * Responses are bounded too: `limitedJson()` serializes once, measures, and
 * refuses (500 RESPONSE_TOO_LARGE, cause logged) instead of sending an
 * accidentally unbounded result.
 *
 * Caps live in ROUTE_BODY_LIMITS so they can be reviewed in one place.
 */

import { NextResponse } from "next/server";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";

const KiB = 1024;
const MiB = 1024 * KiB;

/** Applied when a route has no entry of its own. */
export const DEFAULT_BODY_LIMIT_BYTES = 16 * KiB;
/** Applied to JSON responses that do not set their own cap. */
export const DEFAULT_RESPONSE_LIMIT_BYTES = 2 * MiB;
/** JSON nested deeper than this is rejected before it reaches a handler. */
export const MAX_JSON_DEPTH = 32;

/** Per-route request body caps, in bytes. Keys follow the app/api layout. */
export const ROUTE_BODY_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  "/api/auth/verify": 8 * KiB,
  "/api/auth/refresh": 4 * KiB,
  "/api/analytics/events": 16 * KiB,
  "/api/analytics/database-performance": 4 * KiB,
  "/api/error-report": 32 * KiB,
  "/api/expenses": 64 * KiB,
  "/api/expenses/[id]": 64 * KiB,
  "/api/expenses/[id]/correct": 64 * KiB,
  "/api/expenses/[id]/void": 8 * KiB,
  "/api/exports/archive": 64 * KiB,
  "/api/trips": 64 * KiB,
  "/api/trips/[id]/transfer-ownership": 4 * KiB,
  "/api/trips/[id]/members/[memberId]/role": 4 * KiB,
  "/api/invitations/create": 8 * KiB,
  "/api/invitations/claim": 8 * KiB,
  "/api/invitations/revoke": 4 * KiB,
  "/api/onboarding/sponsor": 8 * KiB,
  "/api/onboarding/revoke": 4 * KiB,
  "/api/settlement/attest": 8 * KiB,
  "/api/settlement/reconcile": 8 * KiB,
  "/api/settlement/reconciliation-worker": 4 * KiB,
  "/api/support/lookup": 4 * KiB,
  "/api/support/actions/propose": 16 * KiB,
  "/api/support/actions/approve": 8 * KiB,
  "/api/outbox/worker": 4 * KiB,
  "/api/developer/providers": 4 * KiB,
  "/api/developer/stellar-cache": 4 * KiB,
  "/api/developer/stellar-resilience": 4 * KiB,
  "/api/v1/tokens": 8 * KiB,
  "/api/v1/trips": 64 * KiB,
  "/api/v1/expenses": 64 * KiB,
  "/api/v1/webhooks": 8 * KiB,
  "/api/v1/webhooks/test": 8 * KiB,
  "/api/admin/objects/rotate": 8 * KiB,
  "/api/admin/objects/crypto-erase": 8 * KiB,
});

/** Per-route response caps for routes that can return large collections. */
export const ROUTE_RESPONSE_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  "/api/exports/archive": 25 * MiB,
  "/api/account/export": 25 * MiB,
  "/api/settlement/reconciliation-worker": 4 * MiB,
  "/api/support/audit-logs": 4 * MiB,
  "/api/v1/audit-logs": 4 * MiB,
});

export function bodyLimitFor(route: string): number {
  return ROUTE_BODY_LIMITS[route] ?? DEFAULT_BODY_LIMIT_BYTES;
}

export function responseLimitFor(route: string): number {
  return ROUTE_RESPONSE_LIMITS[route] ?? DEFAULT_RESPONSE_LIMIT_BYTES;
}

export type BodyErrorCode =
  | "BODY_TOO_LARGE"
  | "UNSUPPORTED_MEDIA_TYPE"
  | "INVALID_CONTENT_LENGTH"
  | "INVALID_BODY_ENCODING"
  | "INVALID_JSON"
  | "JSON_TOO_DEEP"
  | "BODY_REQUIRED"
  | "INVALID_BODY_SHAPE"
  | "BODY_READ_FAILED";

const STATUS: Record<BodyErrorCode, 400 | 413 | 415> = {
  BODY_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  INVALID_CONTENT_LENGTH: 400,
  INVALID_BODY_ENCODING: 400,
  INVALID_JSON: 400,
  JSON_TOO_DEEP: 400,
  BODY_REQUIRED: 400,
  INVALID_BODY_SHAPE: 400,
  BODY_READ_FAILED: 400,
};

const MESSAGES: Record<BodyErrorCode, string> = {
  BODY_TOO_LARGE: "Request body is too large.",
  UNSUPPORTED_MEDIA_TYPE: "Unsupported Content-Type.",
  INVALID_CONTENT_LENGTH: "Content-Length header is malformed.",
  INVALID_BODY_ENCODING: "Request body must be valid UTF-8.",
  INVALID_JSON: "Request body must be valid JSON.",
  JSON_TOO_DEEP: "Request body is nested too deeply.",
  BODY_REQUIRED: "A request body is required.",
  INVALID_BODY_SHAPE: "Request body has the wrong shape.",
  BODY_READ_FAILED: "Request body could not be read.",
};

export class RequestBodyError extends Error {
  readonly code: BodyErrorCode;
  readonly status: 400 | 413 | 415;

  constructor(code: BodyErrorCode, message = MESSAGES[code]) {
    super(message);
    this.name = "RequestBodyError";
    this.code = code;
    this.status = STATUS[code];
  }
}

/** `flat` is `{ error, code }`; `v1` is the developer API `{ error: { code, message, status } }`. */
export type BodyErrorFormat = "flat" | "v1";

export function bodyErrorResponse(
  err: RequestBodyError,
  options: { format?: BodyErrorFormat; requestId?: string; maxBytes?: number } = {},
): NextResponse {
  const body =
    options.format === "v1"
      ? { error: { code: err.code, message: err.message, status: err.status } }
      : { error: err.message, code: err.code, ...(options.requestId ? { requestId: options.requestId } : {}) };
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (options.requestId) headers[REQUEST_ID_HEADER] = options.requestId;
  if (err.status === 415) headers["Accept"] = "application/json";
  if (err.status === 413 && options.maxBytes) headers["X-Max-Body-Bytes"] = String(options.maxBytes);
  return NextResponse.json(body, { status: err.status, headers });
}

interface RequestLike {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

function mediaType(headers: RequestLike["headers"]): string {
  return (headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
}

export function isJsonMediaType(type: string): boolean {
  return type === "application/json" || (type.startsWith("application/") && type.endsWith("+json"));
}

/** Validates Content-Length. Returns the declared size, or null when absent. */
function declaredLength(headers: RequestLike["headers"], maxBytes: number): number | null {
  const raw = headers.get("content-length");
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d{1,15}$/.test(raw.trim())) throw new RequestBodyError("INVALID_CONTENT_LENGTH");
  const n = Number(raw.trim());
  if (n > maxBytes) throw new RequestBodyError("BODY_TOO_LARGE");
  return n;
}

/**
 * Reads at most `maxBytes` from the request stream. Cancels the stream and
 * throws BODY_TOO_LARGE as soon as the count passes the cap. A stream that
 * errors mid-read is BODY_READ_FAILED, never an unhandled exception.
 */
export async function readLimitedBytes(request: RequestLike, maxBytes: number): Promise<Uint8Array> {
  declaredLength(request.headers, maxBytes);
  const stream = request.body;
  if (!stream) return new Uint8Array(0);

  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    reader = stream.getReader();
  } catch {
    throw new RequestBodyError("BODY_READ_FAILED");
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
      total += chunk.byteLength;
      if (total > maxBytes) {
        reader.cancel().catch(() => {});
        throw new RequestBodyError("BODY_TOO_LARGE");
      }
      chunks.push(chunk);
    }
  } catch (err) {
    if (err instanceof RequestBodyError) throw err;
    reader.cancel().catch(() => {});
    throw new RequestBodyError("BODY_READ_FAILED");
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Already released or cancelled.
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Depth of nested arrays/objects, computed iteratively (no recursion to exhaust). */
export function jsonDepth(value: unknown, limit = MAX_JSON_DEPTH): number {
  let max = 0;
  const stack: Array<{ v: unknown; d: number }> = [{ v: value, d: 0 }];
  while (stack.length > 0) {
    const { v, d } = stack.pop()!;
    if (v === null || typeof v !== "object") continue;
    const depth = d + 1;
    if (depth > max) max = depth;
    if (max > limit) return max;
    const children = Array.isArray(v) ? v : Object.values(v as Record<string, unknown>);
    for (const child of children) {
      if (child !== null && typeof child === "object") stack.push({ v: child, d: depth });
    }
  }
  return max;
}

export interface ReadBodyOptions {
  /** Route key in ROUTE_BODY_LIMITS; used when `maxBytes` is not given. */
  route?: string;
  maxBytes?: number;
  /** An empty body yields `undefined` instead of BODY_REQUIRED. */
  allowEmpty?: boolean;
  /** Required top-level JSON shape. Defaults to "object". */
  expect?: "object" | "array" | "any";
  /** Extra schema check; return an error message to reject with 400. */
  validate?: (value: unknown) => string | null;
}

const decoder = () => new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

/** Reads and decodes a UTF-8 text body under the cap (used by text routes). */
export async function readTextBody(request: RequestLike, options: ReadBodyOptions = {}): Promise<string> {
  const maxBytes = options.maxBytes ?? bodyLimitFor(options.route ?? "");
  const bytes = await readLimitedBytes(request, maxBytes);
  try {
    return decoder().decode(bytes);
  } catch {
    throw new RequestBodyError("INVALID_BODY_ENCODING");
  }
}

/**
 * Reads a JSON body through every check listed in the module header.
 * Throws RequestBodyError; use `parseJsonBody` for a result object instead.
 */
export async function readJsonBody<T = unknown>(request: RequestLike, options: ReadBodyOptions = {}): Promise<T> {
  const maxBytes = options.maxBytes ?? bodyLimitFor(options.route ?? "");
  const type = mediaType(request.headers);
  declaredLength(request.headers, maxBytes);

  // A declared non-JSON type is refused before a byte is read.
  if (type !== "" && !isJsonMediaType(type)) {
    request.body?.cancel().catch(() => {});
    throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE");
  }

  // No declared type: only an empty body is acceptable (checked below).
  const text = await readTextBody(request, { maxBytes });
  if (text.trim() === "") {
    if (options.allowEmpty) return undefined as T;
    throw new RequestBodyError("BODY_REQUIRED");
  }
  if (!isJsonMediaType(type)) throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE");

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new RequestBodyError("INVALID_JSON");
  }
  if (jsonDepth(value) > MAX_JSON_DEPTH) throw new RequestBodyError("JSON_TOO_DEEP");

  const expect = options.expect ?? "object";
  if (expect === "object" && (value === null || typeof value !== "object" || Array.isArray(value))) {
    throw new RequestBodyError("INVALID_BODY_SHAPE", "Request body must be a JSON object.");
  }
  if (expect === "array" && !Array.isArray(value)) {
    throw new RequestBodyError("INVALID_BODY_SHAPE", "Request body must be a JSON array.");
  }
  const problem = options.validate?.(value) ?? null;
  if (problem) throw new RequestBodyError("INVALID_BODY_SHAPE", problem);
  return value as T;
}

export type ParsedBody<T> = { ok: true; value: T } | { ok: false; error: RequestBodyError; response: NextResponse };

/**
 * `readJsonBody` as a result: `if (!parsed.ok) return parsed.response;`.
 * Never throws.
 */
export async function parseJsonBody<T = unknown>(
  request: RequestLike,
  options: ReadBodyOptions & { format?: BodyErrorFormat; requestId?: string } = {},
): Promise<ParsedBody<T>> {
  const maxBytes = options.maxBytes ?? bodyLimitFor(options.route ?? "");
  try {
    return { ok: true, value: await readJsonBody<T>(request, { ...options, maxBytes }) };
  } catch (err) {
    const error = err instanceof RequestBodyError ? err : new RequestBodyError("BODY_READ_FAILED");
    return {
      ok: false,
      error,
      response: bodyErrorResponse(error, { format: options.format, requestId: options.requestId, maxBytes }),
    };
  }
}

/**
 * Reads a multipart body under the cap, then parses it. formData() buffers
 * the whole body itself, so the bytes are counted first.
 */
export async function readLimitedFormData(request: RequestLike & { url: string }, maxBytes: number): Promise<FormData> {
  const type = mediaType(request.headers);
  if (type !== "multipart/form-data") throw new RequestBodyError("UNSUPPORTED_MEDIA_TYPE");
  const bytes = await readLimitedBytes(request, maxBytes);
  try {
    return await new Request(request.url, {
      method: "POST",
      headers: { "content-type": request.headers.get("content-type") ?? "" },
      body: bytes as unknown as BodyInit,
    }).formData();
  } catch {
    throw new RequestBodyError("BODY_READ_FAILED", "Send the request as multipart/form-data.");
  }
}

export class ResponseTooLargeError extends Error {
  readonly code = "RESPONSE_TOO_LARGE";
  readonly bytes: number;
  readonly maxBytes: number;

  constructor(bytes: number, maxBytes: number) {
    super(`Response of ${bytes} bytes exceeds the ${maxBytes}-byte limit.`);
    this.name = "ResponseTooLargeError";
    this.bytes = bytes;
    this.maxBytes = maxBytes;
  }
}

/** Serializes once and measures. Throws ResponseTooLargeError above the cap. */
export function serializeBounded(body: unknown, maxBytes: number, space?: number): string {
  const text = JSON.stringify(body, null, space);
  const bytes = Buffer.byteLength(text ?? "");
  if (bytes > maxBytes) throw new ResponseTooLargeError(bytes, maxBytes);
  return text ?? "null";
}

/**
 * Drop-in for `NextResponse.json` that refuses to send more than `maxBytes`.
 * An oversized result is replaced by a 500 with a stable code, and the size
 * is logged (never the data).
 */
export function limitedJson(
  body: unknown,
  init: ResponseInit = {},
  maxBytes: number = DEFAULT_RESPONSE_LIMIT_BYTES,
): NextResponse {
  const headers = new Headers(init.headers);
  try {
    const text = serializeBounded(body, maxBytes);
    headers.set("Content-Type", "application/json");
    return new NextResponse(text, { ...init, headers });
  } catch (err) {
    if (!(err instanceof ResponseTooLargeError)) throw err;
    const requestId = headers.get(REQUEST_ID_HEADER) ?? undefined;
    console.error(
      `[api:response-limit] ${JSON.stringify({ requestId, code: err.code, bytes: err.bytes, maxBytes: err.maxBytes })}`,
    );
    const errorHeaders: Record<string, string> = { "Cache-Control": "no-store" };
    if (requestId) errorHeaders[REQUEST_ID_HEADER] = requestId;
    return NextResponse.json(
      { error: "The response was too large to send. Narrow the request and try again.", code: err.code, ...(requestId ? { requestId } : {}) },
      { status: 500, headers: errorHeaders },
    );
  }
}
