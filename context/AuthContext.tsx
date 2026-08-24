"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { isSupabaseConfigured, resetSupabaseClient } from "@/lib/supabase/client";
import { fetchUserByWallet, updateUserDisplayName, DatabaseError } from "@/lib/supabase/queries";
import { setSession, clearSession, getSessionWallet } from "@/lib/supabase/session";
import { useAccessToken } from "@/lib/supabase/useSession";
import { useWalletContext } from "./WalletContext";
import { LS_USER, LS_PUBLIC_KEY } from "@/lib/utils/constants";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface User {
  id: string;
  walletAddress: string;
  displayName: string;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string;
}

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;
  /** Set when the database itself is unreachable or not yet installed. */
  error: string | null;
  signUp: (displayName: string) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => void;
  updateProfile: (updates: Partial<Pick<User, "displayName">>) => Promise<void>;
  /** Re-reads the profile from the database. */
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);
AuthContext.displayName = "AuthContext";

// ─── Profile cache (per wallet) ───────────────────────────────────────────────
// Keyed by wallet so switching wallets can never show the previous wallet's
// name while the new profile loads.

function cacheKey(walletAddress: string) {
  return `${LS_USER}:${walletAddress}`;
}

function saveUserToCache(user: User) {
  try {
    if (user.walletAddress) {
      localStorage.setItem(cacheKey(user.walletAddress), JSON.stringify(user));
    }
  } catch {}
}

function loadUserFromCache(walletAddress?: string | null): User | null {
  try {
    const key = walletAddress ?? localStorage.getItem(LS_PUBLIC_KEY);
    if (!key) return null;
    const raw = localStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as User;
    // Guard against a cache entry written under a different wallet.
    return parsed?.walletAddress === key ? parsed : null;
  } catch {
    return null;
  }
}

function clearUserCache(walletAddress?: string | null) {
  try {
    const key = walletAddress ?? localStorage.getItem(LS_PUBLIC_KEY);
    if (key) localStorage.removeItem(cacheKey(key));
  } catch {}
}

// ─── Wallet challenge / response ──────────────────────────────────────────────

interface VerifyResult {
  token: string | null;
  user: User | null;
  needsSignUp?: boolean;
}

/**
 * Runs the full wallet handshake: fetch a challenge, have the wallet sign it,
 * and exchange the signature for a session.
 *
 * When `displayName` is supplied the server also creates the profile, so
 * sign-up completes in this single exchange rather than in a follow-up insert
 * that could fail on its own and leave a token without an account behind it.
 */
async function authenticateWallet(
  publicKey: string,
  displayName?: string
): Promise<VerifyResult> {
  const challengeRes = await fetch(
    `/api/auth/challenge?address=${encodeURIComponent(publicKey)}`,
    { cache: "no-store" }
  );
  if (!challengeRes.ok) {
    const err = await challengeRes.json().catch(() => ({}));
    throw new Error(err.error || "Could not start wallet verification.");
  }
  const challenge = await challengeRes.json();

  const { signXDR } = await import("@/lib/freighter");
  const signedXdr = await signXDR(challenge.xdr);

  const verifyRes = await fetch("/api/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      address: publicKey,
      signedXdr,
      nonce: challenge.nonce,
      expiration: challenge.expiration,
      signature: challenge.signature,
      ...(displayName ? { displayName } : {}),
    }),
  });

  const payload = await verifyRes.json().catch(() => ({}));

  if (!verifyRes.ok) {
    if (payload?.needsSignUp) {
      return { token: null, user: null, needsSignUp: true };
    }
    throw new Error(payload?.error || "Wallet signature verification failed.");
  }

  return { token: payload.token ?? null, user: payload.user ?? null };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { publicKey, isConnected, isHydrated } = useWalletContext();
  const token = useAccessToken();

  const [user, setUser] = useState<User | null>(() =>
    typeof window !== "undefined" ? loadUserFromCache() : null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Identifies the in-flight load, so a slow response for a wallet the user has
  // already switched away from is discarded instead of overwriting state.
  const loadIdRef = useRef(0);

  const isAuthenticated = Boolean(user) && isConnected && Boolean(token);

  const loadProfile = useCallback(
    async (walletAddress: string) => {
      const loadId = ++loadIdRef.current;
      const isStale = () => loadId !== loadIdRef.current;

      if (!isSupabaseConfigured()) {
        if (!isStale()) {
          setError(
            "Supabase is not configured. Add NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY to .env.local."
          );
          setIsLoading(false);
        }
        return;
      }

      try {
        const profile = await fetchUserByWallet(walletAddress);
        if (isStale()) return;

        if (profile) {
          setUser(profile);
          saveUserToCache(profile);
          setError(null);
        } else {
          // Authenticated, but the profile row is gone — treat as signed out
          // rather than showing a stale cached name.
          setUser(null);
          clearUserCache(walletAddress);
          clearSession();
        }
      } catch (err) {
        if (isStale()) return;
        // The wallet is verified and the profile is cached; a database hiccup
        // should not eject the user, so keep the cached profile and surface
        // the problem instead.
        const message =
          err instanceof DatabaseError || err instanceof Error
            ? err.message
            : "Could not reach the database.";
        setError(message);

        const cached = loadUserFromCache(walletAddress);
        if (cached) setUser(cached);
      } finally {
        if (!isStale()) setIsLoading(false);
      }
    },
    []
  );

  // ── Keep the profile in step with the wallet + session ────────────────────
  // Depends on `token`, so the moment sign-up or sign-in mints one this re-runs
  // and the profile loads. The old implementation read the token straight out
  // of localStorage, so nothing re-rendered when it appeared and the app stayed
  // on empty data until a manual reload.

  useEffect(() => {
    if (!isHydrated) return;

    if (!publicKey) {
      loadIdRef.current++;
      setUser(null);
      setError(null);
      setIsLoading(false);
      return;
    }

    if (!token) {
      // Wallet connected but not signed in yet.
      loadIdRef.current++;
      setUser(null);
      setIsLoading(false);
      return;
    }

    if (getSessionWallet() !== publicKey) {
      // The session belongs to a different wallet — drop it and require a
      // fresh signature rather than showing another wallet's data.
      loadIdRef.current++;
      clearSession();
      setUser(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    void loadProfile(publicKey);
  }, [publicKey, token, isHydrated, loadProfile]);

  // ── Sign up ───────────────────────────────────────────────────────────────

  const signUp = useCallback(
    async (displayName: string) => {
      if (!publicKey) throw new Error("Connect your wallet first.");

      const name = displayName?.trim();
      if (!name) throw new Error("Display name is required");

      const result = await authenticateWallet(publicKey, name);

      if (!result.token || !result.user) {
        throw new Error("Sign up did not complete. Please try again.");
      }

      setSession(result.token);
      setUser(result.user);
      saveUserToCache(result.user);
      setError(null);
      setIsLoading(false);
    },
    [publicKey]
  );

  // ── Sign in ───────────────────────────────────────────────────────────────

  const signIn = useCallback(async () => {
    if (!publicKey) throw new Error("Connect your wallet first.");

    const result = await authenticateWallet(publicKey);

    if (result.needsSignUp) {
      throw new Error("No account found for this wallet. Please sign up first.");
    }
    if (!result.token || !result.user) {
      throw new Error("Sign in did not complete. Please try again.");
    }

    setSession(result.token);
    setUser(result.user);
    saveUserToCache(result.user);
    setError(null);
    setIsLoading(false);
  }, [publicKey]);

  // ── Sign out ──────────────────────────────────────────────────────────────

  const signOut = useCallback(() => {
    loadIdRef.current++;
    setUser(null);
    setError(null);
    clearUserCache(publicKey);
    // Drops the session and tears down every open Realtime channel, so the
    // next wallet does not inherit subscriptions opened for this one.
    resetSupabaseClient();
  }, [publicKey]);

  // ── Update profile ────────────────────────────────────────────────────────

  const updateProfile = useCallback(
    async (updates: Partial<Pick<User, "displayName">>) => {
      if (!publicKey || !user) throw new Error("Not authenticated");

      const displayName = updates.displayName?.trim();
      if (!displayName) throw new Error("Display name is required");
      if (displayName === user.displayName) return;

      const updated = await updateUserDisplayName(publicKey, displayName);
      setUser(updated);
      saveUserToCache(updated);
    },
    [publicKey, user]
  );

  const refresh = useCallback(async () => {
    if (!publicKey || !token) return;
    await loadProfile(publicKey);
  }, [publicKey, token, loadProfile]);

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    error,
    signUp,
    signIn,
    signOut,
    updateProfile,
    refresh,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
