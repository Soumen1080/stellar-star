import crypto from "crypto";
import { type ApiScope, type ApiTokenRecord, type ScopedTokenPayload, ALL_API_SCOPES } from "./types";

const TOKEN_PREFIX = "stk_live_";

declare global {
  var stellarStarTokenStore: Map<string, ApiTokenRecord> | undefined;
}

const tokenStore = globalThis.stellarStarTokenStore ?? new Map<string, ApiTokenRecord>();
globalThis.stellarStarTokenStore = tokenStore;

function getApiSigningSecret(): string {
  const secret = process.env.API_SIGNING_SECRET || process.env.SUPABASE_JWT_SECRET || process.env.JWT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test") {
      return "dev-api-signing-secret-key-32-chars-minimum-required";
    }
    throw new Error("API_SIGNING_SECRET is not configured.");
  }
  return secret;
}

function base64UrlEncode(str: string): string {
  return Buffer.from(str)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(str: string): string {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");
  return Buffer.from(withPadding, "base64").toString("utf-8");
}

function signSegment(data: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(data).digest("hex");
}

/**
 * Mints a scoped developer API token tied to a Stellar wallet.
 * Invariant: Never issues or returns a Supabase service role key.
 */
export function generateScopedToken({
  walletAddress,
  name,
  scopes,
  expiresInDays = 90,
}: {
  walletAddress: string;
  name: string;
  scopes: ApiScope[];
  expiresInDays?: number | null;
}): { token: string; record: ApiTokenRecord } {
  const normalizedWallet = walletAddress.trim().toUpperCase();
  const validScopes = scopes.filter((s) => ALL_API_SCOPES.includes(s));
  if (validScopes.length === 0) {
    throw new Error("At least one valid API scope must be granted.");
  }

  const tokenId = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const expiresAt =
    expiresInDays !== null && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000).toISOString()
      : null;

  const payload: ScopedTokenPayload = {
    tokenId,
    walletAddress: normalizedWallet,
    name: name.trim() || "Default API Token",
    scopes: validScopes,
    createdAt,
    expiresAt,
  };

  const payloadEncoded = base64UrlEncode(JSON.stringify(payload));
  const signature = signSegment(payloadEncoded, getApiSigningSecret());
  const token = `${TOKEN_PREFIX}${payloadEncoded}.${signature}`;
  const tokenMasked = `${TOKEN_PREFIX}...${signature.slice(-6)}`;

  const record: ApiTokenRecord = {
    ...payload,
    tokenMasked,
    revokedAt: null,
    lastUsedAt: null,
  };

  tokenStore.set(tokenId, record);

  return { token, record };
}

/**
 * Validates a developer API token and checks signature, expiration, and revocation status.
 * Rejects raw service role keys and malformed strings.
 */
export function verifyScopedToken(rawToken: string): {
  valid: boolean;
  payload?: ScopedTokenPayload;
  error?: string;
} {
  if (!rawToken || typeof rawToken !== "string") {
    return { valid: false, error: "Missing or invalid token format." };
  }

  const trimmed = rawToken.trim();

  // Strict check: Never allow Supabase service role or raw secret keys
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (serviceKey && trimmed === serviceKey) {
    return { valid: false, error: "Raw Supabase service keys are forbidden on public API routes." };
  }

  if (trimmed.startsWith("eyJ")) {
    try {
      const parts = trimmed.split(".");
      if (parts.length >= 2) {
        const decoded = JSON.parse(base64UrlDecode(parts[1]));
        if (decoded.role === "service_role") {
          return { valid: false, error: "Service role tokens cannot be used as developer API credentials." };
        }
      }
    } catch {}
  }

  if (!trimmed.startsWith(TOKEN_PREFIX)) {
    return { valid: false, error: "Invalid token prefix. Expected stk_live_..." };
  }

  const tokenBody = trimmed.slice(TOKEN_PREFIX.length);
  const [payloadSegment, signature] = tokenBody.split(".");

  if (!payloadSegment || !signature) {
    return { valid: false, error: "Malformed token signature." };
  }

  const expectedSig = signSegment(payloadSegment, getApiSigningSecret());
  const bufSig = Buffer.from(signature);
  const bufExpected = Buffer.from(expectedSig);

  if (bufSig.length !== bufExpected.length || !crypto.timingSafeEqual(bufSig, bufExpected)) {
    return { valid: false, error: "Invalid token signature." };
  }

  let payload: ScopedTokenPayload;
  try {
    payload = JSON.parse(base64UrlDecode(payloadSegment));
  } catch {
    return { valid: false, error: "Corrupted token payload." };
  }

  if (payload.expiresAt && new Date(payload.expiresAt).getTime() <= Date.now()) {
    return { valid: false, error: "API token has expired." };
  }

  // Check revocation store
  const stored = tokenStore.get(payload.tokenId);
  if (stored && stored.revokedAt) {
    return { valid: false, error: "API token has been revoked." };
  }

  // Update last used timestamp
  if (stored) {
    stored.lastUsedAt = new Date().toISOString();
  }

  return { valid: true, payload };
}

/** Lists active and revoked tokens created by a wallet. */
export function listTokensForWallet(walletAddress: string): ApiTokenRecord[] {
  const normalized = walletAddress.trim().toUpperCase();
  const results: ApiTokenRecord[] = [];
  for (const record of tokenStore.values()) {
    if (record.walletAddress === normalized) {
      results.push({ ...record });
    }
  }
  return results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

/** Revokes an existing API token by ID. */
export function revokeToken(tokenId: string, walletAddress: string): boolean {
  const normalized = walletAddress.trim().toUpperCase();
  const record = tokenStore.get(tokenId);
  if (!record || record.walletAddress !== normalized) {
    return false;
  }
  record.revokedAt = new Date().toISOString();
  return true;
}

/** Clears the in-memory token store (primarily for unit tests). */
export function clearTokenStore(): void {
  tokenStore.clear();
}
