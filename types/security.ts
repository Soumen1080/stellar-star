/**
 * types/security.ts
 *
 * Types for rate limiting, abuse protection policies, and security event logging.
 */

export type AbuseScope =
  | "auth.challenge"
  | "auth.verify"
  | "auth.refresh"
  | "invitation.create"
  | "invitation.claim"
  | "invitation.verify"
  | "invitation.revoke"
  | "receipt.upload"
  | "reminder.send"
  | "payment.intent"
  | "idempotency.key";

export interface RateLimitPolicy {
  limit: number;
  windowMs: number;
}

export interface PublicRateLimitPolicy {
  ip?: RateLimitPolicy;
  wallet?: RateLimitPolicy;
  endpoint?: RateLimitPolicy;
  challengeAfterBlocks?: number;
}
