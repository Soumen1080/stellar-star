/**
 * The wallet session: the JWT minted by /api/auth/verify after a Stellar
 * signature check, plus the claims decoded from it.
 *
 * This module is the single source of truth for "am I authenticated right
 * now". It is an observable store rather than a bare localStorage read so that
 * React can *react* to a session appearing: previously the token was written
 * to localStorage during sign-up, but no state changed, so the trip/expense
 * providers never re-ran their fetch and the app sat on empty data until a
 * full page reload.
 */

import { LS_PUBLIC_KEY } from "@/lib/utils/constants";

export const LS_AUTH_TOKEN = "StellarStar:authToken";

/** Refresh the session this many ms before the JWT actually expires. */
const EXPIRY_SKEW_MS = 60_000;

export interface SessionClaims {
  sub: string;
  wallet_address: string;
  role: string;
  /** Seconds since epoch. */
  exp: number;
  iat: number;
}

export interface Session {
  token: string;
  claims: SessionClaims;
}

// ─── JWT decoding ─────────────────────────────────────────────────────────────

function base64UrlDecode(segment: string): string {
  const padded = segment.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), "=");

  if (typeof atob === "function") {
    // atob yields a binary string; round-trip it through UTF-8 so non-ASCII
    // claim values survive.
    const binary = atob(withPadding);
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return Buffer.from(withPadding, "base64").toString("utf8");
}

/**
 * Reads the claims out of a JWT. This does NOT verify the signature — it can't,
 * the secret is server-side only. Verification happens in Postgres on every
 * request. The claims are read here purely to know when to stop using a token
 * and to avoid firing requests that are guaranteed to 401.
 */
export function decodeClaims(token: string): SessionClaims | null {
  try {
    const [, payload] = token.split(".");
    if (!payload) return null;

    const claims = JSON.parse(base64UrlDecode(payload)) as Partial<SessionClaims>;
    if (
      typeof claims.wallet_address !== "string" ||
      !claims.wallet_address ||
      typeof claims.exp !== "number"
    ) {
      return null;
    }
    return claims as SessionClaims;
  } catch {
    return null;
  }
}

export function isExpired(claims: SessionClaims, skewMs = EXPIRY_SKEW_MS): boolean {
  return claims.exp * 1000 - skewMs <= Date.now();
}

// ─── Store ────────────────────────────────────────────────────────────────────

let current: Session | null = null;
let hydrated = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Reads the persisted token, dropping it if it is malformed or expired. */
function hydrate(): void {
  hydrated = true;
  if (typeof window === "undefined") return;

  let token: string | null = null;
  try {
    token = window.localStorage.getItem(LS_AUTH_TOKEN);
  } catch {
    return;
  }
  if (!token) return;

  const claims = decodeClaims(token);
  if (!claims || isExpired(claims)) {
    try {
      window.localStorage.removeItem(LS_AUTH_TOKEN);
    } catch {}
    return;
  }
  current = { token, claims };
}

/**
 * The active session, or null. Returns null for a session whose token has
 * expired, so callers never send a request that is certain to be rejected.
 */
export function getSession(): Session | null {
  if (!hydrated) hydrate();
  if (current && isExpired(current.claims)) {
    clearSession();
    return null;
  }
  return current;
}

export function getAccessToken(): string | null {
  return getSession()?.token ?? null;
}

/** The wallet address this session is authenticated as, if any. */
export function getSessionWallet(): string | null {
  return getSession()?.claims.wallet_address ?? null;
}

/**
 * True when there is a live session for `walletAddress`. Every data provider
 * gates on this: querying with a session belonging to a different wallet would
 * return that other wallet's rows.
 */
export function hasSessionFor(walletAddress: string | null | undefined): boolean {
  if (!walletAddress) return false;
  return getSessionWallet() === walletAddress;
}

export function setSession(token: string): Session {
  const claims = decodeClaims(token);
  if (!claims) throw new Error("Received a malformed session token from the server.");

  current = { token, claims };
  hydrated = true;
  try {
    window.localStorage.setItem(LS_AUTH_TOKEN, token);
  } catch {}
  emit();
  return current;
}

export function clearSession(): void {
  const had = current !== null;
  current = null;
  hydrated = true;
  try {
    window.localStorage.removeItem(LS_AUTH_TOKEN);
  } catch {}
  if (had) emit();
}

/**
 * Mirrors a sign-in or sign-out performed in another tab into this one.
 * A single shared handler, attached while anyone is subscribed.
 */
function onStorage(event: StorageEvent): void {
  if (event.key !== LS_AUTH_TOKEN && event.key !== LS_PUBLIC_KEY) return;
  current = null;
  hydrated = false;
  hydrate();
  emit();
}

/** Subscribes to session changes, including ones made in another tab. */
export function subscribe(listener: () => void): () => void {
  const isFirst = listeners.size === 0;
  listeners.add(listener);

  if (isFirst && typeof window !== "undefined") {
    window.addEventListener("storage", onStorage);
  }

  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof window !== "undefined") {
      window.removeEventListener("storage", onStorage);
    }
  };
}

/**
 * Snapshot for `useSyncExternalStore`. Returns the token string (a primitive)
 * rather than the Session object so the identity is stable between reads.
 */
export function getTokenSnapshot(): string | null {
  return getSession()?.token ?? null;
}

export function getServerTokenSnapshot(): string | null {
  return null;
}

/** Test hook: drops in-memory state so a fresh hydrate happens on next read. */
export function __resetSessionForTests(): void {
  current = null;
  hydrated = false;
  listeners.clear();
}
