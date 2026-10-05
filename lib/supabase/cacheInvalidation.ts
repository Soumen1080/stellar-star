import { LS_EXPENSES, LS_TRIPS } from "@/lib/utils/constants";

export type QueryCacheDomain = "trips" | "expenses";

export interface QueryCacheInvalidation {
  wallet: string;
  domains: readonly QueryCacheDomain[];
  tripId?: string;
  expenseId?: string;
  revision: string;
}

type InvalidationInput = Omit<QueryCacheInvalidation, "revision">;

const INVALIDATION_EVENT = "stellar-star:query-cache-invalidated";
const INVALIDATION_BROADCAST_KEY = "StellarStar:cache-invalidation";

const cachePrefixes: Record<QueryCacheDomain, string> = {
  trips: LS_TRIPS,
  expenses: LS_EXPENSES,
};

function isQueryCacheInvalidation(value: unknown): value is QueryCacheInvalidation {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<QueryCacheInvalidation>;
  return (
    typeof candidate.wallet === "string" &&
    typeof candidate.revision === "string" &&
    Array.isArray(candidate.domains) &&
    candidate.domains.every((domain) => domain === "trips" || domain === "expenses")
  );
}

function notifyCurrentTab(detail: QueryCacheInvalidation): void {
  window.dispatchEvent(new CustomEvent<QueryCacheInvalidation>(INVALIDATION_EVENT, { detail }));
}

/**
 * Marks wallet-scoped query families stale and asks every mounted consumer to
 * revalidate. The event includes entity ids so narrower caches can subscribe
 * later without changing mutation call sites.
 */
export function invalidateQueryCaches(input: InvalidationInput): void {
  if (typeof window === "undefined" || input.domains.length === 0) return;

  const detail: QueryCacheInvalidation = {
    ...input,
    domains: [...new Set(input.domains)],
    revision: `${Date.now()}:${Math.random().toString(36).slice(2)}`,
  };

  notifyCurrentTab(detail);

  // A storage event wakes the same wallet's views in other tabs. The source
  // tab already received the CustomEvent above; storage events do not echo to it.
  try {
    localStorage.setItem(INVALIDATION_BROADCAST_KEY, JSON.stringify(detail));
    localStorage.removeItem(INVALIDATION_BROADCAST_KEY);
  } catch {
    // Private browsing can reject storage writes. Same-tab invalidation still works.
  }
}

export function subscribeToQueryInvalidation(
  wallet: string,
  domain: QueryCacheDomain,
  listener: (event: QueryCacheInvalidation) => void,
): () => void {
  if (typeof window === "undefined") return () => {};

  const notifyIfRelevant = (detail: QueryCacheInvalidation) => {
    if (detail.wallet === wallet && detail.domains.includes(domain)) {
      listener(detail);
    }
  };

  const onLocalInvalidation = (event: Event) => {
    const detail = (event as CustomEvent<QueryCacheInvalidation>).detail;
    if (isQueryCacheInvalidation(detail)) notifyIfRelevant(detail);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== INVALIDATION_BROADCAST_KEY || !event.newValue) return;
    try {
      const detail: unknown = JSON.parse(event.newValue);
      if (isQueryCacheInvalidation(detail)) notifyIfRelevant(detail);
    } catch {
      // Ignore malformed events written by older clients or browser extensions.
    }
  };

  window.addEventListener(INVALIDATION_EVENT, onLocalInvalidation);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(INVALIDATION_EVENT, onLocalInvalidation);
    window.removeEventListener("storage", onStorage);
  };
}

export function walletCollectionCacheKey(domain: QueryCacheDomain, wallet: string): string {
  return `${cachePrefixes[domain]}:${wallet}`;
}
