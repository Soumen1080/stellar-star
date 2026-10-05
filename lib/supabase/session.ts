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
    return {
      ...claims,
      wallet_address: claims.wallet_address.trim().toUpperCase(),
    } as SessionClaims;
  } catch {
    return null;
  }
}

export const SESSION_REFRESH_WINDOW_MS = 60 * 60 * 1000;

export function isExpired(claims: SessionClaims, skewMs = EXPIRY_SKEW_MS): boolean {
  return claims.exp * 1000 - skewMs <= Date.now();
}

/**
 * Checks whether the session is valid and within its renewal window (default: 1 hour).
 */
export function isExpiringSoon(
  claims: SessionClaims,
  windowMs = SESSION_REFRESH_WINDOW_MS
): boolean {
  if (isExpired(claims)) return false;
  return claims.exp * 1000 - Date.now() <= windowMs;
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
  if (
    current &&
    typeof window !== "undefined" &&
    typeof fetch === "function" &&
    !inFlightRefresh &&
    isExpiringSoon(current.claims)
  ) {
    void refreshSession(current.token);
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
  const sessionWallet = getSessionWallet();
  if (!sessionWallet) return false;
  return sessionWallet.trim().toUpperCase() === walletAddress.trim().toUpperCase();
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

let inFlightRefresh: Promise<Session | null> | null = null;

/**
 * Silently renews the active session via POST /api/auth/refresh when within
 * the renewal window. Deduplicates concurrent in-flight refresh requests.
 */
export async function refreshSession(currentToken?: string): Promise<Session | null> {
  if (inFlightRefresh) {
    return inFlightRefresh;
  }

  const token = currentToken ?? current?.token;
  if (!token) return null;

  inFlightRefresh = (async () => {
    try {
      const res = await fetch("/api/auth/refresh", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data?.token && typeof data.token === "string") {
          return setSession(data.token);
        }
      } else if (res.status === 401) {
        // Token is expired or invalid on the server
        clearSession();
        return null;
      }
      return current;
    } catch (err) {
      console.warn("[session] Silent session renewal request failed:", err);
      return current;
    } finally {
      inFlightRefresh = null;
    }
  })();

  return inFlightRefresh;
}

/** Test hook: drops in-memory state so a fresh hydrate happens on next read. */
export function __resetSessionForTests(): void {
  current = null;
  hydrated = false;
  inFlightRefresh = null;
  listeners.clear();
}
