import crypto from "crypto";

/**
 * Lazily resolved (not cached at module load) so a missing secret fails the
 * request that needs it rather than silently falling back to a value that is
 * public in this repo's history - a shared fallback would let anyone forge
 * session JWTs with an arbitrary wallet_address claim.
 */
function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      return "dev-local-jwt-secret-not-for-production-use";
    }
    throw new Error(
      "SUPABASE_JWT_SECRET (or JWT_SECRET) is not configured. Set it to the Supabase project's JWT signing secret."
    );
  }
  return secret;
}

export function generateChallengeSignature(address: string, nonce: string, expiration: number): string {
  const data = `${address}:${nonce}:${expiration}`;
  return crypto.createHmac("sha256", getJwtSecret()).update(data).digest("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export function signSupabaseJwt(payload: object, expiresInSeconds: number = 3600): string {
  const header = {
    alg: "HS256",
    typ: "JWT",
  };
  
  const now = Math.floor(Date.now() / 1000);
  const fullPayload = {
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };
  
  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(fullPayload)));

  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", getJwtSecret()).update(signatureInput).digest();
  const encodedSignature = base64url(signature);
  
  return `${signatureInput}.${encodedSignature}`;
}
