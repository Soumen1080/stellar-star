import crypto from "crypto";

const JWT_SECRET = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET || "super-secret-jwt-key-with-at-least-32-characters-long";

export function generateChallengeSignature(address: string, nonce: string, expiration: number): string {
  const data = `${address}:${nonce}:${expiration}`;
  return crypto.createHmac("sha256", JWT_SECRET).update(data).digest("hex");
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
  const signature = crypto.createHmac("sha256", JWT_SECRET).update(signatureInput).digest();
  const encodedSignature = base64url(signature);
  
  return `${signatureInput}.${encodedSignature}`;
}
