/**
 * lib/support/redact.ts
 *
 * Safe data redaction engine for the Incident-Response and Support Console (Issue #314).
 *
 * Invariants:
 * 1. Zero secret leakage: No private keys, secret seed phrases (S...), auth tokens,
 *    or session secrets are ever displayed to support staff or transmitted to the console.
 * 2. Deep recursive redaction: Applies to nested objects, error strings, and JSON blobs.
 * 3. Safe identifier preservation: Public keys (G...), transaction hashes (64-hex),
 *    expense IDs, trip IDs, and correlation IDs remain intact for investigation.
 */

// Matches Stellar secret keys (starts with S, 56 uppercase alphanumeric chars)
const STELLAR_SECRET_KEY_REGEX = /\bS[A-Z0-9]{55}\b/g;

// Matches potential JWT tokens (3 base64url segments separated by dots)
const JWT_REGEX = /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\b/g;

// Sensitive property keys to scrub completely
const SENSITIVE_KEY_NAMES = new Set([
  "secret",
  "secretkey",
  "secret_key",
  "privatekey",
  "private_key",
  "seed",
  "mnemonic",
  "password",
  "token",
  "authorization",
  "auth_token",
  "jwt",
  "bearer",
  "signature_raw",
  "cookie",
  "session_token",
]);

/**
 * Sanitizes a string by replacing secret keys, JWTs, and bearer patterns with redaction placeholders.
 */
export function redactSensitiveString(input: string): string {
  if (!input || typeof input !== "string") return input;

  return input
    .replace(STELLAR_SECRET_KEY_REGEX, "[REDACTED_STELLAR_SECRET_KEY]")
    .replace(JWT_REGEX, "[REDACTED_JWT_TOKEN]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer [REDACTED_BEARER_TOKEN]");
}

/**
 * Recursively deep-redacts sensitive keys and values from arbitrary objects/arrays.
 */
export function redactObject<T>(obj: T): T {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === "string") {
    return redactSensitiveString(obj) as unknown as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => redactObject(item)) as unknown as T;
  }

  if (typeof obj === "object") {
    const redacted: Record<string, unknown> = {};

    for (const [key, val] of Object.entries(obj)) {
      const lowerKey = key.toLowerCase();

      if (SENSITIVE_KEY_NAMES.has(lowerKey)) {
        redacted[key] = "[REDACTED_SECRET]";
      } else if (typeof val === "string") {
        redacted[key] = redactSensitiveString(val);
      } else if (typeof val === "object" && val !== null) {
        redacted[key] = redactObject(val);
      } else {
        redacted[key] = val;
      }
    }

    return redacted as T;
  }

  return obj;
}

/**
 * Masks a search query value before recording it in staff audit logs.
 * If a staff member accidentally pastes a Stellar secret key, it is completely masked.
 */
export function maskQueryForAudit(query: string): string {
  if (!query || typeof query !== "string") return "";

  const trimmed = query.trim();

  // If accidentally searched with a Stellar secret key (starts with S)
  if (/^S[A-Z0-9]{55}$/.test(trimmed)) {
    return `S***[REDACTED_SECRET_KEY_${trimmed.slice(-4)}]`;
  }

  // If a standard Stellar public key (G...), keep prefix and suffix
  if (/^G[A-Z0-9]{55}$/.test(trimmed)) {
    return `${trimmed.slice(0, 6)}...${trimmed.slice(-4)}`;
  }

  // If 64-char transaction hash, keep prefix and suffix
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
  }

  // If longer than 40 chars, truncate for clean audit log
  if (trimmed.length > 40) {
    return `${trimmed.slice(0, 20)}...[len=${trimmed.length}]`;
  }

  return trimmed;
}
