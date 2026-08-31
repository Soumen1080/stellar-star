import crypto from "crypto";

/**
 * Generates a 256-bit cryptographically unguessable invitation token.
 */
export function generateInviteToken(): string {
  if (typeof window !== "undefined" && window.crypto?.getRandomValues) {
    const bytes = new Uint8Array(32);
    window.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Computes a deterministic SHA-256 hash of the invitation token.
 * Only the hash is stored in the database, protecting capabilities even if database is read.
 */
export function hashToken(token: string): string {
  const clean = (token ?? "").trim();
  return crypto.createHash("sha256").update(clean).digest("hex");
}

/**
 * Formats the public invitation URL for sharing.
 */
export function buildInviteUrl(token: string, baseUrl?: string): string {
  const origin = baseUrl || (typeof window !== "undefined" ? window.location.origin : "");
  return `${origin}/join/${token}`;
}
