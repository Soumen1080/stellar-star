"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { supabase, createAuthenticatedClient, isSupabaseConfigured } from "@/lib/supabase/client";
import { useWalletContext } from "./WalletContext";
import { LS_USER } from "@/lib/utils/constants";

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
  signUp: (displayName: string) => Promise<void>;
  signIn: () => Promise<void>;
  signOut: () => void;
  updateProfile: (updates: Partial<Pick<User, "displayName">>) => Promise<void>;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const AuthContext = createContext<AuthContextType | null>(null);
AuthContext.displayName = "AuthContext";

// ─── Helper: Convert DB row to User ───────────────────────────────────────────

function dbRowToUser(row: any): User {
  return {
    id: row.id,
    walletAddress: row.wallet_address,
    displayName: row.display_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

// ─── Provider ─────────────────────────────────────────────────────────────────

// ─── localStorage helpers ────────────────────────────────────────────────────

function saveUserToCache(user: User) {
  try { localStorage.setItem(LS_USER, JSON.stringify(user)); } catch {}
}

function loadUserFromCache(): User | null {
  try {
    const raw = localStorage.getItem(LS_USER);
    return raw ? (JSON.parse(raw) as User) : null;
  } catch { return null; }
}

function clearUserCache() {
  try { localStorage.removeItem(LS_USER); } catch {}
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(() => {
    // Restore user immediately from cache on first render (avoids flash on refresh)
    if (typeof window !== "undefined") return loadUserFromCache();
    return null;
  });
  const [isLoading, setIsLoading] = useState(true);
  const { publicKey, isConnected, isHydrated } = useWalletContext();

  const isAuthenticated = !!user && isConnected;

  // ── Load user profile when wallet connects ────────────────────────────────────────────────────────

  useEffect(() => {
    // Wait for wallet hydration to complete before making auth decisions
    if (!isHydrated) return;

    if (!publicKey) {
      setUser(null);
      clearUserCache();
      setIsLoading(false);
      return;
    }

    async function loadUser() {
      if (!isSupabaseConfigured() || !supabase) {
        setIsLoading(false);
        return;
      }
      try {
        const { data, error } = await supabase
          .from("users")
          .select("*")
          .eq("wallet_address", publicKey)
          .single();

        if (error) {
          if (error.code === "PGRST116") {
            // No user found - user needs to sign up
            setUser(null);
            clearUserCache();
          }
          // On network errors, keep the cached user (don't log out)
        } else if (data) {
          const loadedUser = dbRowToUser(data);
          setUser(loadedUser);
          saveUserToCache(loadedUser);
        }
      } catch (err) {
        // Network error - keep cached user so user stays logged in
      } finally {
        setIsLoading(false);
      }
    }

    loadUser();
  }, [publicKey, isHydrated]);

  // ── Sign up: Create new user profile ──────────────────────────────────────

  const signUp = useCallback(
    async (displayName: string) => {
      if (!publicKey) {
        throw new Error("Wallet not connected");
      }

      if (!displayName || !displayName.trim()) {
        throw new Error("Display name is required");
      }

      try {
        const client = createAuthenticatedClient(publicKey);
        
        const { data, error } = await client
          .from("users")
          .insert({
            wallet_address: publicKey,
            display_name: displayName.trim(),
          })
          .select()
          .single();

        if (error) {
          if (error.code === '23505') {
            throw new Error("This wallet is already registered. Please sign in instead.");
          } else if (error.message.includes('permission denied') || error.message.includes('policy')) {
            throw new Error("Access denied. Please make sure your database is properly configured.");
          } else if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
            throw new Error("Cannot connect to the server. Please check your internet connection.");
          } else {
            throw new Error(error.message || "Failed to create account. Please try again.");
          }
        }

        if (data) {
          const newUser = dbRowToUser(data);
          setUser(newUser);
          saveUserToCache(newUser);
        }
      } catch (err: any) {
        // Check for network errors
        if (err?.message?.includes('Failed to fetch') || err?.name === 'TypeError') {
          throw new Error("Cannot connect to server. Please check your internet connection or try again later.");
        }
        throw err;
      }
    },
    [publicKey]
  );

  // ── Sign in: Update last login time ───────────────────────────────────────

  const signIn = useCallback(async () => {
    if (!publicKey) {
      throw new Error("Wallet not connected");
    }

    try {
      // Use authenticated client with wallet header for RLS policies
      const client = createAuthenticatedClient(publicKey);
      
      const { data, error } = await client
        .from("users")
        .update({ last_login_at: new Date().toISOString() })
        .eq("wallet_address", publicKey)
        .select()
        .single();

      if (error) {
        if (error.code === "PGRST116") {
          throw new Error("No account found. Please sign up first.");
        }
        if (error.message?.includes('Failed to fetch') || error.message?.includes('NetworkError')) {
          throw new Error("Cannot connect to server. Please check your internet connection.");
        }
        throw new Error(error.message || "Sign in failed");
      }

      if (data) {
        const signedInUser = dbRowToUser(data);
        setUser(signedInUser);
        saveUserToCache(signedInUser);
      }
    } catch (err: any) {
      // Check for network errors
      if (err?.message?.includes('Failed to fetch') || err?.name === 'TypeError') {
        throw new Error("Cannot connect to server. Please check your internet connection and try again.");
      }
      throw err;
    }
  }, [publicKey]);

  // ── Sign out: Clear user state ──────────────────────────────────────────

  const signOut = useCallback(() => {
    setUser(null);
    clearUserCache();
  }, []);

  // ── Update profile ─────────────────────────────────────────────────────────

  const updateProfile = useCallback(
    async (updates: Partial<Pick<User, "displayName">>) => {
      if (!publicKey || !user) {
        throw new Error("Not authenticated");
      }

      try {
        // Use authenticated client with wallet header for RLS policies
        const client = createAuthenticatedClient(publicKey);
        
        const { data, error } = await client
          .from("users")
          .update({
            display_name: updates.displayName ?? user.displayName,
          })
          .eq("wallet_address", publicKey)
          .select()
          .single();

        if (error) {
          throw new Error(error.message || "Failed to update profile");
        }

        if (data) {
          const updatedUser = dbRowToUser(data);
          setUser(updatedUser);
          saveUserToCache(updatedUser);
        }
      } catch (err: any) {
        throw err;
      }
    },
    [publicKey, user]
  );

  // ──────────────────────────────────────────────────────────────────────────

  const value: AuthContextType = {
    user,
    isLoading,
    isAuthenticated,
    signUp,
    signIn,
    signOut,
    updateProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
