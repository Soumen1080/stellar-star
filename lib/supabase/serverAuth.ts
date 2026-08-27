import crypto from "crypto";

/**
 * Mints the session JWTs that PostgREST and Realtime verify.
 *
 * The signing key is the Supabase project's JWT secret, so a token minted here
 * is indistinguishable to Postgres from one issued by Supabase Auth, and
 * `current_setting('request.jwt.claims')` inside an RLS policy sees the
 * `wallet_address` claim put there below.
 */

/** How long a wallet session lasts before the user must sign again. */
export const SESSION_TTL_SECONDS = 24 * 60 * 60;

/** How long a signing challenge stays valid. */
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;

/**
 * Resolved per call rather than cached at module load, so a missing secret
 * fails the request that needs it instead of silently falling back to a value
 * that is public in this repo's history — a shared fallback would let anyone
 * forge a session JWT with an arbitrary wallet_address claim.
 */
function getJwtSecret(): string {
  const secret = process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "development") {
      return "dev-local-jwt-secret-not-for-production-use";
    }
    throw new Error(
      "SUPABASE_JWT_SECRET (or JWT_SECRET) is not configured. Set it to the Supabase project's JWT signing secret (Dashboard → Project Settings → API → JWT Settings)."
    );
  }
  return secret;
}

/** The Supabase project ref, parsed from the project URL. Used as the `ref` claim. */
function getProjectRef(): string | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (!url) return null;
  const match = /^https?:\/\/([a-z0-9-]+)\.supabase\.(co|in|net)/i.exec(url.trim());
  return match ? match[1] : null;
}

export function generateChallengeSignature(
  address: string,
  nonce: string,
  expiration: number
): string {
  const data = `${address}:${nonce}:${expiration}`;
  return crypto.createHmac("sha256", getJwtSecret()).update(data).digest("hex");
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export interface WalletSessionClaims {
  sub: string;
  wallet_address: string;
  [key: string]: unknown;
}

export function signSupabaseJwt(
  payload: object,
  expiresInSeconds: number = 3600
): string {
  const header = { alg: "HS256", typ: "JWT" };

  const now = Math.floor(Date.now() / 1000);
  const ref = getProjectRef();

  const fullPayload = {
    // `iss` and `ref` match what Supabase Auth puts on its own tokens; Realtime
    // is stricter than PostgREST about their presence.
    iss: "supabase",
    ...(ref ? { ref } : {}),
    aud: "authenticated",
    role: "authenticated",
    ...payload,
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encodedHeader = base64url(Buffer.from(JSON.stringify(header)));
  const encodedPayload = base64url(Buffer.from(JSON.stringify(fullPayload)));

  const signatureInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", getJwtSecret()).update(signatureInput).digest();

  return `${signatureInput}.${base64url(signature)}`;
}

/**
 * Verifies a session token this server minted and returns its claims.
 *
 * Returns null for anything that does not verify — bad signature, wrong
 * algorithm, expired, or malformed — so callers can treat "no claims" as "not
 * authenticated" without distinguishing failure modes to the client.
 *
 * The `alg` check matters: accepting the header's algorithm at face value is
 * how JWT verifiers get talked into `none`, or into verifying an HMAC against
 * a public key.
 */
export function verifyWalletSession(token: string): WalletSessionClaims | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  let header: { alg?: string };
  let payload: WalletSessionClaims & { exp?: number };
  try {
    header = JSON.parse(Buffer.from(encodedHeader, "base64url").toString("utf8"));
    payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }

  if (header.alg !== "HS256") return null;

  const expected = crypto
    .createHmac("sha256", getJwtSecret())
    .update(`${encodedHeader}.${encodedPayload}`)
    .digest();
  const provided = Buffer.from(encodedSignature, "base64url");

  if (provided.length !== expected.length) return null;
  if (!crypto.timingSafeEqual(provided, expected)) return null;

  if (typeof payload.exp !== "number" || payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.wallet_address !== "string" || !payload.wallet_address) return null;

  return payload;
}

/** Mints the session token for a wallet whose signature has been verified. */
export function signWalletSession(
  walletAddress: string,
  subject: string = walletAddress,
  ttlSeconds: number = SESSION_TTL_SECONDS
): string {
  return signSupabaseJwt(
    {
      sub: subject,
      wallet_address: walletAddress,
    } satisfies WalletSessionClaims,
    ttlSeconds
  );
}
