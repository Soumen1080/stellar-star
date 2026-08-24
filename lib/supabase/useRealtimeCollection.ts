"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { RealtimeChannel, RealtimePostgresChangesPayload } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "./client";
import { DatabaseError } from "./queries";
import { useAccessToken, useSessionWallet } from "./useSession";

/**
 * Loads a wallet-scoped table, keeps it live over Realtime, and falls back to a
 * per-wallet localStorage cache when the database cannot be reached.
 *
 * The trips and expenses providers were separate near-identical copies of this
 * logic; sharing it means a fix to the fetch/subscribe lifecycle lands in both.
 */

export interface RealtimeCollectionOptions<T> {
  /** Table to subscribe to, e.g. "trips". */
  table: string;
  /** localStorage key prefix; the connected wallet is appended. */
  cacheKey: string;
  /** Reads the whole collection the session's wallet may see. */
  fetchAll: () => Promise<T[]>;
  /** Maps a Realtime row payload into the domain shape. */
  fromRow: (row: any) => T;
  /** Stable identity for an item. */
  getId: (item: T) => string;
  /**
   * The wallet currently connected in the browser.
   *
   * Data loads only when this matches the wallet inside the session JWT. If the
   * user switches wallets without signing in again, the stale session would
   * otherwise keep serving the previous wallet's rows under the new wallet's
   * name.
   */
  connectedWallet: string | null;
}

export interface RealtimeCollection<T> {
  items: T[];
  isLoading: boolean;
  /** True when showing cached data because the database could not be read. */
  isOffline: boolean;
  error: string | null;
  /** True when the error is "the schema was never installed". */
  needsSetup: boolean;
  refresh: () => Promise<void>;
  /** Applies a local change immediately; pass a rollback-safe updater. */
  mutate: (updater: (previous: T[]) => T[]) => void;
  /** The wallet the current data belongs to, or null when signed out. */
  wallet: string | null;
}

export function useRealtimeCollection<T>({
  table,
  cacheKey,
  fetchAll,
  fromRow,
  getId,
  connectedWallet,
}: RealtimeCollectionOptions<T>): RealtimeCollection<T> {
  const token = useAccessToken();
  const sessionWallet = useSessionWallet();

  // Null unless the session and the connected wallet are the same account.
  const wallet =
    sessionWallet && connectedWallet && sessionWallet === connectedWallet ? sessionWallet : null;

  const [items, setItems] = useState<T[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isOffline, setIsOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);

  // Discards a response that arrives after the wallet or session changed.
  const loadIdRef = useRef(0);
  const channelRef = useRef<RealtimeChannel | null>(null);

  // ── Per-wallet cache ──────────────────────────────────────────────────────

  const readCache = useCallback((): T[] => {
    if (!wallet) return [];
    try {
      const raw = localStorage.getItem(`${cacheKey}:${wallet}`);
      return raw ? (JSON.parse(raw) as T[]) : [];
    } catch {
      return [];
    }
  }, [cacheKey, wallet]);

  const writeCache = useCallback(
    (next: T[]) => {
      if (!wallet) return;
      try {
        localStorage.setItem(`${cacheKey}:${wallet}`, JSON.stringify(next));
      } catch (err) {
        console.warn(`[StellarStar] Could not cache ${table}:`, err);
      }
    },
    [cacheKey, table, wallet]
  );

  /** Updates state and the cache together so they never disagree. */
  const mutate = useCallback(
    (updater: (previous: T[]) => T[]) => {
      setItems((previous) => {
        const next = updater(previous);
        writeCache(next);
        return next;
      });
    },
    [writeCache]
  );

  // ── Load ──────────────────────────────────────────────────────────────────

  const load = useCallback(async () => {
    const loadId = ++loadIdRef.current;
    const isStale = () => loadId !== loadIdRef.current;

    if (!isSupabaseConfigured()) {
      if (!isStale()) {
        setItems(readCache());
        setIsOffline(true);
        setError("Supabase is not configured — showing locally cached data only.");
        setIsLoading(false);
      }
      return;
    }

    try {
      const rows = await fetchAll();
      if (isStale()) return;

      setItems(rows);
      writeCache(rows);
      setIsOffline(false);
      setError(null);
      setNeedsSetup(false);
    } catch (err) {
      if (isStale()) return;

      const message =
        err instanceof DatabaseError || err instanceof Error
          ? err.message
          : `Could not load ${table}.`;
      const missingSchema =
        err instanceof DatabaseError && err.code === "PGRST205";

      console.warn(`[StellarStar] Falling back to cached ${table}:`, err);
      setItems(readCache());
      setIsOffline(true);
      setNeedsSetup(missingSchema);
      setError(message);
    } finally {
      if (!isStale()) setIsLoading(false);
    }
  }, [fetchAll, readCache, table, writeCache]);

  // Runs on wallet change AND on session change: a token appearing after
  // sign-up is what makes the first real fetch happen.
  useEffect(() => {
    if (!wallet || !token) {
      loadIdRef.current++;
      setItems([]);
      setIsLoading(false);
      setIsOffline(false);
      setError(null);
      return;
    }

    setIsLoading(true);
    void load();
  }, [wallet, token, load]);

  // ── Realtime ──────────────────────────────────────────────────────────────
  // Realtime enforces the same RLS policies as a query, so this receives only
  // rows this wallet is allowed to see.

  useEffect(() => {
    if (!wallet || !token) return;

    const client = getSupabaseClient();
    if (!client) return;

    const applyUpsert = (payload: RealtimePostgresChangesPayload<any>) => {
      const row = payload.new;
      if (!row || !("id" in row)) return;
      const item = fromRow(row);
      const id = getId(item);

      setItems((previous) => {
        const index = previous.findIndex((existing) => getId(existing) === id);
        const next =
          index === -1
            ? [item, ...previous]
            : previous.map((existing, i) => (i === index ? item : existing));
        writeCache(next);
        return next;
      });
    };

    const applyDelete = (payload: RealtimePostgresChangesPayload<any>) => {
      const deletedId = (payload.old as any)?.id;
      if (!deletedId) return;

      setItems((previous) => {
        const next = previous.filter((existing) => getId(existing) !== deletedId);
        writeCache(next);
        return next;
      });
    };

    // The channel name is scoped to the wallet so two wallets open in two tabs
    // do not share (and stomp on) one subscription.
    const channel = client
      .channel(`${table}:${wallet}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table }, applyUpsert)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table }, applyUpsert)
      .on("postgres_changes", { event: "DELETE", schema: "public", table }, applyDelete)
      .subscribe((status) => {
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.warn(`[StellarStar] Realtime channel for ${table} is ${status}.`);
        }
      });

    channelRef.current = channel;

    return () => {
      channelRef.current = null;
      void client.removeChannel(channel);
    };
  }, [table, wallet, token, fromRow, getId, writeCache]);

  // Re-reads on tab focus, catching anything missed while the socket was idle.
  useEffect(() => {
    if (!wallet || !token) return;

    const onVisible = () => {
      if (document.visibilityState === "visible") void load();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [wallet, token, load]);

  return {
    items,
    isLoading,
    isOffline,
    error,
    needsSetup,
    refresh: load,
    mutate,
    wallet,
  };
}
