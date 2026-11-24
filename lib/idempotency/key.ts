/**
 * lib/idempotency/key.ts
 *
 * Idempotency-Key contract for public mutations (Issue #413 / #412).
 *
 * Pure and isomorphic: no Node or Next.js imports, so the browser helpers and
 * the server wrapper share one definition of a "valid key".
 *
 * A key is valid when it is 8–255 characters of visible ASCII (0x21–0x7E):
 * no spaces, control characters, or non-ASCII. UUIDs (the recommended form),
 * ULIDs and prefixed keys such as `copy_<uuid>` all fit. The bounds keep keys
 * cheap to index while rejecting values too short to be unique.
 */

/** Canonical request header. Header names are case-insensitive. */
export const IDEMPOTENCY_KEY_HEADER = "Idempotency-Key";

/** Legacy alias accepted for older clients; must agree with the canonical header. */
export const IDEMPOTENCY_KEY_ALT_HEADER = "X-Idempotency-Key";

/** Set on a response that was replayed from a completed earlier request. */
export const IDEMPOTENT_REPLAYED_HEADER = "Idempotent-Replayed";

export const IDEMPOTENCY_KEY_MIN_LENGTH = 8;
export const IDEMPOTENCY_KEY_MAX_LENGTH = 255;

const VISIBLE_ASCII = /^[\x21-\x7E]+$/;

export type IdempotencyKeyErrorCode = "IDEMPOTENCY_KEY_REQUIRED" | "IDEMPOTENCY_KEY_INVALID";

export type IdempotencyKeyValidation =
  | { ok: true; key: string }
  | { ok: false; code: IdempotencyKeyErrorCode; message: string };

const REQUIRED_MESSAGE =
  `An ${IDEMPOTENCY_KEY_HEADER} header is required for this request. ` +
  `Send a unique value (for example a UUID) and reuse it when retrying the same action.`;

function invalid(message: string): IdempotencyKeyValidation {
  return { ok: false, code: "IDEMPOTENCY_KEY_INVALID", message };
}

/**
 * Validates one candidate key. The value is not trimmed: a key with
 * surrounding whitespace is malformed rather than silently rewritten, so the
 * stored key is always byte-for-byte what the client sent.
 */
export function validateIdempotencyKey(raw: unknown): IdempotencyKeyValidation {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: false, code: "IDEMPOTENCY_KEY_REQUIRED", message: REQUIRED_MESSAGE };
  }
  if (typeof raw !== "string") {
    return invalid(`${IDEMPOTENCY_KEY_HEADER} must be a string.`);
  }
  if (raw.length < IDEMPOTENCY_KEY_MIN_LENGTH || raw.length > IDEMPOTENCY_KEY_MAX_LENGTH) {
    return invalid(
      `${IDEMPOTENCY_KEY_HEADER} must be between ${IDEMPOTENCY_KEY_MIN_LENGTH} and ` +
        `${IDEMPOTENCY_KEY_MAX_LENGTH} characters.`,
    );
  }
  if (!VISIBLE_ASCII.test(raw)) {
    return invalid(
      `${IDEMPOTENCY_KEY_HEADER} may only contain visible ASCII characters (no spaces or control characters).`,
    );
  }
  return { ok: true, key: raw };
}

interface HeaderSource {
  get(name: string): string | null;
}

/**
 * Reads and validates the key for a request.
 *
 * Sources, in order: the `Idempotency-Key` header, the `X-Idempotency-Key`
 * alias, then — only when `body` is given — a legacy `idempotencyKey` field
 * in a JSON body. When more than one source is present they must agree;
 * disagreement is rejected instead of guessing which one the client meant.
 */
export function readIdempotencyKey(headers: HeaderSource, body?: unknown): IdempotencyKeyValidation {
  const candidates: string[] = [];

  for (const name of [IDEMPOTENCY_KEY_HEADER, IDEMPOTENCY_KEY_ALT_HEADER]) {
    const value = headers.get(name);
    if (value !== null && value !== "") candidates.push(value);
  }

  if (body !== undefined && body !== null && typeof body === "object" && !Array.isArray(body)) {
    const fromBody = (body as Record<string, unknown>).idempotencyKey;
    if (fromBody !== undefined && fromBody !== null && fromBody !== "") {
      if (typeof fromBody !== "string") return invalid("idempotencyKey must be a string.");
      candidates.push(fromBody);
    }
  }

  if (candidates.length === 0) return validateIdempotencyKey(undefined);
  if (candidates.some((candidate) => candidate !== candidates[0])) {
    return invalid(
      `Conflicting idempotency keys were supplied; send a single ${IDEMPOTENCY_KEY_HEADER} header.`,
    );
  }
  return validateIdempotencyKey(candidates[0]);
}
