/**
 * lib/idempotency/client.ts
 *
 * Browser helpers for the Idempotency-Key contract (Issue #413 / #412).
 *
 * The rule for callers: one key per user intent. Create it when the action
 * starts, send the same key on every retry of that action (double-click,
 * network retry, reconnect), and start a new key once the action succeeds.
 * After a failed attempt the server has released the key, so reusing it —
 * even with an edited payload — is safe.
 */

import { IDEMPOTENCY_KEY_HEADER } from "./key";

export { IDEMPOTENCY_KEY_HEADER } from "./key";

/** A fresh key: a v4 UUID (36 visible-ASCII characters). */
export function newIdempotencyKey(): string {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
  throw new Error("A secure random source is required to create an idempotency key.");
}

/** `{ "Idempotency-Key": key }`, for spreading into fetch headers. */
export function idempotencyHeaders(key: string): Record<string, string> {
  return { [IDEMPOTENCY_KEY_HEADER]: key };
}

export interface IdempotencyKeyHolder {
  /** The key for the action in progress, created on first use. */
  current(): string;
  /** Call after the action succeeds, so the next action gets a new key. */
  reset(): void;
}

/**
 * Holds one key across retries of a single action. Keep one per form or
 * button (e.g. in a `useRef`), call `current()` for each attempt, and
 * `reset()` on success.
 */
export function createIdempotencyKeyHolder(): IdempotencyKeyHolder {
  let key: string | null = null;
  return {
    current() {
      if (key === null) key = newIdempotencyKey();
      return key;
    },
    reset() {
      key = null;
    },
  };
}

/**
 * Whether a failed response means this key is spent on a different payload.
 * The caller should reset its holder: the user has changed what they are
 * asking for, so it is a new action.
 */
export function isIdempotencyConflict(status: number, body: unknown): boolean {
  if (status !== 409 || !body || typeof body !== "object") return false;
  const code =
    (body as { code?: unknown }).code ??
    ((body as { error?: { code?: unknown } }).error as { code?: unknown } | undefined)?.code;
  return code === "IDEMPOTENCY_CONFLICT";
}
