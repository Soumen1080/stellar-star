"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Expense } from "@/types/expense";
import { getAccessToken } from "@/lib/supabase/session";
import {
  EMPTY_HISTORY_FILTERS,
  historyFiltersToParams,
  matchesExpenseHistoryFilters,
  parseHistoryFilters,
  type ExpenseHistoryFilters,
} from "@/lib/expense/historyFilters";

export const HISTORY_PAGE_SIZE = 20;
/** Matches MAX_PAGE_SIZE on the server; a refresh never asks for more. */
const MAX_REFRESH_SIZE = 100;

type FilterUpdate =
  | Partial<ExpenseHistoryFilters>
  | ((previous: ExpenseHistoryFilters) => ExpenseHistoryFilters);

/**
 * Filter state mirrored into the page URL.
 *
 * Uses the native History API (which the App Router integrates with) instead
 * of `useSearchParams`, so pages need no Suspense boundary and the hook works
 * the same in tests. The URL is read after mount — reading it during render
 * would make the server-rendered and hydrated markup disagree — and `ready`
 * stays false until then so callers do not fetch an unfiltered page first.
 */
export function useHistoryUrlState() {
  const [filters, setFiltersState] = useState<ExpenseHistoryFilters>(() => ({
    ...EMPTY_HISTORY_FILTERS,
    tags: [],
  }));
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const readFromUrl = () =>
      setFiltersState(parseHistoryFilters(new URLSearchParams(window.location.search)));
    readFromUrl();
    setReady(true);
    window.addEventListener("popstate", readFromUrl);
    return () => window.removeEventListener("popstate", readFromUrl);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const params = historyFiltersToParams(filters, new URLSearchParams(window.location.search));
    const search = params.toString();
    const next = `${window.location.pathname}${search ? `?${search}` : ""}${window.location.hash}`;
    const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
    if (next !== current) window.history.replaceState(window.history.state, "", next);
  }, [filters, ready]);

  const setFilters = useCallback((update: FilterUpdate) => {
    setFiltersState((previous) =>
      typeof update === "function" ? update(previous) : { ...previous, ...update },
    );
  }, []);

  const resetFilters = useCallback(() => {
    setFiltersState({ ...EMPTY_HISTORY_FILTERS, tags: [] });
  }, []);

  return { filters, setFilters, resetFilters, ready };
}

interface UseExpenseHistoryOptions {
  filters: ExpenseHistoryFilters;
  /** Restrict to one trip. */
  tripId?: string;
  /**
   * Expenses already held by the realtime cache. Used when the server cannot be
   * asked (no session, offline, search not migrated yet) so the list degrades
   * to local filtering instead of going blank.
   */
  fallbackExpenses: Expense[];
  /** False until URL state is read, so the first request is the filtered one. */
  enabled?: boolean;
  /** Changes when the underlying data changes (realtime), triggering a refetch. */
  refreshKey?: string;
}

interface PageResponse {
  data: Expense[];
  pagination: { nextCursor: string | null; hasMore: boolean };
}

/**
 * Server-side, paginated expense history for the given filters.
 *
 * `source` reports where the visible rows came from: `"server"` when the API
 * answered, `"local"` when they were filtered from the cached collection.
 */
export function useExpenseHistory({
  filters,
  tripId,
  fallbackExpenses,
  enabled = true,
  refreshKey = "",
}: UseExpenseHistoryOptions) {
  const filtersKey = historyFiltersToParams(filters).toString();
  const [serverItems, setServerItems] = useState<Expense[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [serverHasMore, setServerHasMore] = useState(false);
  const [source, setSource] = useState<"server" | "local">("local");
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [localVisible, setLocalVisible] = useState(HISTORY_PAGE_SIZE);
  const loadedCountRef = useRef(0);
  loadedCountRef.current = serverItems.length;

  const localMatches = useMemo(
    () =>
      fallbackExpenses
        .filter((expense) => matchesExpenseHistoryFilters(expense, filters))
        .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)),
    // `filtersKey` captures every field of `filters`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [fallbackExpenses, filtersKey],
  );

  const fetchPage = useCallback(
    async (cursor: string | null, limit: number, signal: AbortSignal): Promise<PageResponse | null> => {
      const token = getAccessToken();
      if (!token || typeof fetch !== "function") return null;

      const params = new URLSearchParams(filtersKey);
      params.set("limit", String(limit));
      params.set("tzOffset", String(new Date().getTimezoneOffset()));
      if (tripId) params.set("tripId", tripId);
      if (cursor) params.set("cursor", cursor);

      const res = await fetch(`/api/expenses?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error || "Could not search expenses.");
      return body as PageResponse;
    },
    [filtersKey, tripId],
  );

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const limit = Math.min(Math.max(HISTORY_PAGE_SIZE, loadedCountRef.current), MAX_REFRESH_SIZE);

    setLoading(true);
    setLocalVisible(HISTORY_PAGE_SIZE);
    fetchPage(null, limit, controller.signal)
      .then((page) => {
        if (controller.signal.aborted) return;
        setError(null);
        if (!page) {
          setSource("local");
          return;
        }
        setServerItems(page.data);
        setNextCursor(page.pagination.nextCursor);
        setServerHasMore(page.pagination.hasMore);
        setSource("server");
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : "Could not search expenses.");
        setSource("local");
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [enabled, fetchPage, refreshKey]);

  const loadMore = useCallback(async () => {
    if (source === "local") {
      setLocalVisible((count) => count + HISTORY_PAGE_SIZE);
      return;
    }
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await fetchPage(nextCursor, HISTORY_PAGE_SIZE, new AbortController().signal);
      if (!page) return;
      setServerItems((previous) => {
        const seen = new Set(previous.map((expense) => expense.id));
        return [...previous, ...page.data.filter((expense) => !seen.has(expense.id))];
      });
      setNextCursor(page.pagination.nextCursor);
      setServerHasMore(page.pagination.hasMore);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not load more expenses.");
    } finally {
      setLoadingMore(false);
    }
  }, [fetchPage, loadingMore, nextCursor, source]);

  const isLocal = source === "local";
  return {
    items: isLocal ? localMatches.slice(0, localVisible) : serverItems,
    hasMore: isLocal ? localMatches.length > localVisible : serverHasMore,
    /** Exact only for local results; the server reports pages, not totals. */
    localTotal: isLocal ? localMatches.length : null,
    loadMore,
    loading,
    loadingMore,
    error,
    source,
  };
}
