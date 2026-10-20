import { EVENT_TAXONOMY, isAllowedEventName } from "./taxonomy";
import { type AnalyticsEvent, type AnalyticsEventName } from "./types";

/**
 * Patterns matching sensitive user data that must NEVER enter product analytics.
 * Note: Non-global regexes are used for testing strings to prevent regex statefulness.
 */
export const SENSITIVE_PATTERNS = {
  stellarPublicKey: /\bG[A-Z2-7]{55}\b/,
  stellarSecretKey: /\bS[A-Z2-7]{55}\b/,
  stellarMuxedAddress: /\bM[A-Z2-7]{68}\b/,
  sorobanContractId: /\bC[A-Z2-7]{55}\b/,
  xdrPayload: /\bAAAA[A-Za-z0-9+/=]{24,}\b/,
  jwtToken: /\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/,
  dataUri: /^data:(image|application)\/[a-zA-Z0-9.+-]+;base64,/i,
  base64Blob: /^[A-Za-z0-9+/]{80,}={0,2}$/,
};

const FORBIDDEN_KEY_PATTERN =
  /^(wallet_?address|account_?id|public_?key|pub_?key|secret_?key|seed|private_?key|priv_?key|tx_?xdr|xdr|memo|description|title|notes|receipt_?(ocr|file|data)?|ocr|jwt|auth_token)$/i;

/**
 * Deeply scans any object or primitive to check if it contains sensitive data.
 * Used for automated regression testing and runtime validation.
 */
export function containsSensitiveData(data: unknown): boolean {
  if (data === null || data === undefined) return false;

  if (typeof data === "string") {
    const trimmed = data.trim();
    if (
      SENSITIVE_PATTERNS.stellarPublicKey.test(trimmed) ||
      SENSITIVE_PATTERNS.stellarSecretKey.test(trimmed) ||
      SENSITIVE_PATTERNS.stellarMuxedAddress.test(trimmed) ||
      SENSITIVE_PATTERNS.sorobanContractId.test(trimmed) ||
      SENSITIVE_PATTERNS.xdrPayload.test(trimmed) ||
      SENSITIVE_PATTERNS.jwtToken.test(trimmed) ||
      SENSITIVE_PATTERNS.dataUri.test(trimmed) ||
      SENSITIVE_PATTERNS.base64Blob.test(trimmed)
    ) {
      return true;
    }
    return false;
  }

  if (Array.isArray(data)) {
    return data.some(containsSensitiveData);
  }

  if (typeof data === "object") {
    for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        return true;
      }
      if (containsSensitiveData(value)) {
        return true;
      }
    }
  }

  return false;
}

/**
 * Sanitizes and redacts an event before submission:
 * 1. Checks that the event is recognized in the public taxonomy.
 * 2. Whitelists only properties explicitly allowed for this specific event.
 * 3. Scans all remaining values to guarantee zero leak of addresses, XDR, or PII.
 */
export function sanitizeAnalyticsPayload<TProps extends Record<string, unknown>>(
  eventName: AnalyticsEventName,
  rawProps?: TProps
): TProps {
  if (!isAllowedEventName(eventName)) {
    throw new Error(`Unrecognized analytics event name: "${eventName}"`);
  }

  const def = EVENT_TAXONOMY[eventName];
  const allowedSet = new Set(def.allowedProperties);
  const sanitized: Record<string, unknown> = {};

  if (!rawProps || typeof rawProps !== "object") {
    return sanitized as TProps;
  }

  for (const [key, val] of Object.entries(rawProps)) {
    // Only accept whitelisted properties for this event
    if (!allowedSet.has(key)) {
      continue;
    }

    // Explicitly reject forbidden key names
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      continue;
    }

    if (typeof val === "string") {
      let cleaned = val.trim();
      // Redact any accidental Stellar addresses or keys
      cleaned = cleaned
        .replace(/\bG[A-Z2-7]{55}\b/g, "[REDACTED_ADDRESS]")
        .replace(/\bS[A-Z2-7]{55}\b/g, "[REDACTED_SECRET]")
        .replace(/\bM[A-Z2-7]{68}\b/g, "[REDACTED_ADDRESS]")
        .replace(/\bC[A-Z2-7]{55}\b/g, "[REDACTED_CONTRACT]")
        .replace(/\bAAAA[A-Za-z0-9+/=]{24,}\b/g, "[REDACTED_XDR]")
        .replace(/\bey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, "[REDACTED_JWT]");

      if (SENSITIVE_PATTERNS.dataUri.test(cleaned) || SENSITIVE_PATTERNS.base64Blob.test(cleaned)) {
        cleaned = "[REDACTED_BLOB]";
      }

      sanitized[key] = cleaned;
    } else if (typeof val === "number" || typeof val === "boolean") {
      sanitized[key] = val;
    } else {
      // Complex objects or arrays are disallowed
      sanitized[key] = "[REDACTED_COMPLEX_DATA]";
    }
  }

  return sanitized as TProps;
}

/**
 * Validates and redacts the full AnalyticsEvent envelope.
 */
export function sanitizeAnalyticsEvent(event: AnalyticsEvent): AnalyticsEvent {
  const sanitizedProps = sanitizeAnalyticsPayload(event.name, event.properties as Record<string, unknown>);

  // Ensure session contains no PII or wallet addresses
  const sanitizedSession = {
    id: typeof event.session?.id === "string" ? event.session.id.slice(0, 36) : "anonymous",
    locale: typeof event.session?.locale === "string" ? event.session.locale : "en-US",
  };

  return {
    ...event,
    properties: sanitizedProps as any,
    session: sanitizedSession,
  };
}
