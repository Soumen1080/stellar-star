"use client";

import { useSyncExternalStore } from "react";
import {
  subscribe,
  getTokenSnapshot,
  getServerTokenSnapshot,
  decodeClaims,
} from "./session";

/**
 * The current wallet session token, as reactive React state.
 *
 * Any provider that reads data should depend on this: when a sign-up or
 * sign-in mints a token, every consumer re-renders and re-runs its fetch, so
 * data appears immediately instead of after a manual page reload.
 */
export function useAccessToken(): string | null {
  return useSyncExternalStore(subscribe, getTokenSnapshot, getServerTokenSnapshot);
}

/** The wallet address the current session authenticates as, or null. */
export function useSessionWallet(): string | null {
  const token = useAccessToken();
  if (!token) return null;
  return decodeClaims(token)?.wallet_address ?? null;
}

/**
 * True when there is a live session belonging to `walletAddress`.
 *
 * Providers gate their queries on this rather than on the connected wallet
 * alone: a connected-but-unauthenticated wallet has no JWT, so its queries
 * would return nothing under RLS and read as "my data disappeared".
 */
export function useHasSessionFor(walletAddress: string | null | undefined): boolean {
  const sessionWallet = useSessionWallet();
  return Boolean(walletAddress) && sessionWallet === walletAddress;
}
