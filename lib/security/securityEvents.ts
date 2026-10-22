/**
 * lib/security/securityEvents.ts
 *
 * Security telemetry, identifier redaction, and event recording.
 */

import crypto from "crypto";

export interface SecurityEventPayload {
  event: string;
  scope: string;
  ipHash?: string;
  walletHash?: string;
  endpoint?: string;
  requestId?: string;
  metadata?: Record<string, unknown>;
}

export function redactSecurityIdentifier(identifier?: string | null): string | undefined {
  if (!identifier) return undefined;
  return crypto.createHash("sha256").update(identifier).digest("hex").slice(0, 16);
}

export async function recordSecurityEvent(payload: SecurityEventPayload): Promise<void> {
  // In non-production or testing, log warning for blocked or suspicious security events
  if (process.env.NODE_ENV !== "production") {
    // console.info("[security.event]", payload);
  }
}
