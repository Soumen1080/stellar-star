import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { getAccessToken, clearSession } from "./session";

export type StellarStarClient = SupabaseClient<Database>;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";

const configured = Boolean(supabaseUrl && supabaseAnonKey);

if (!configured && typeof window !== "undefined") {
  console.warn(
    "[StellarStar] Supabase is not configured — running in offline/cache-only mode. " +
      "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
  );
}

/** True when the Supabase env vars are present and the client is usable. */
export function isSupabaseConfigured(): boolean {
  return configured;
}

/**
 * One browser client for the whole app.
 *
 * `accessToken` is supabase-js's third-party-auth hook: it is consulted on
 * every PostgREST request and every Realtime (re)connect, so the current wallet
 * JWT is always attached and an expired one is never reused. That replaces the
 * previous approach of baking a token into `global.headers` and keeping a
 * per-wallet cache of clients, which went stale the moment a token was renewed
 * and left orphaned Realtime sockets behind on every wallet switch.
 *
 * Because the token itself carries the `wallet_address` claim that RLS filters
 * on, a single shared client is correct across wallet switches — the identity
 * travels with the request, not with the client instance.
 */
let browserClient: StellarStarClient | null = null;
const authenticatedClients = new Map<string, StellarStarClient>();

function createBrowserClient(): StellarStarClient {
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    accessToken: async () => getAccessToken(),
    db: { schema: "public" },
    realtime: { params: { eventsPerSecond: 10 } },
    global: {
      headers: { "x-client-info": "stellar-star" },
    },
  });
}

/**
 * The Supabase client, or null when the project is not configured.
 *
 * Requests made without a wallet session are sent as `anon`, which RLS limits
 * to public data (user profiles). Anything scoped to a wallet needs a session —
 * use `requireClient` for those.
 */
export function getSupabaseClient(): StellarStarClient | null {
  if (!configured) return null;
  if (!browserClient) browserClient = createBrowserClient();
  return browserClient;
}

/**
 * The client, throwing a message worth showing a user when Supabase is not
 * configured at all.
 */
export function requireSupabaseClient(): StellarStarClient {
  const client = getSupabaseClient();
  if (!client) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local, then restart the dev server."
    );
  }
  return client;
}

/**
 * The client for a request that must run as an authenticated wallet.
 * Throws before hitting the network when no live session exists, so callers get
 * "sign in again" instead of an empty result set that looks like missing data.
 */
export function requireAuthenticatedClient(): StellarStarClient {
  const client = requireSupabaseClient();
  if (!getAccessToken()) {
    throw new Error("Your session has expired. Please sign in with your wallet again.");
  }
  return client;
}

/**
 * Tears down every Realtime channel and forgets the session. Called on
 * disconnect and sign-out so a subsequent wallet does not inherit live
 * subscriptions opened for the previous one.
 */
export function resetSupabaseClient(): void {
  if (browserClient) {
    void browserClient.removeAllChannels();
  }
  authenticatedClients.clear();
  clearSession();
}

/**
 * Back-compat shim for callers written against the previous API.
 * @deprecated Use `getSupabaseClient()` — the client no longer varies by wallet.
 */
export const supabase: StellarStarClient | null = configured ? (getSupabaseClient() as StellarStarClient) : null;

/** @deprecated Use `requireAuthenticatedClient()`. */
export function createAuthenticatedClient(walletAddress = "__active__"): StellarStarClient {
  const client = requireAuthenticatedClient();
  const cached = authenticatedClients.get(walletAddress);
  if (cached) return cached;

  authenticatedClients.set(walletAddress, client);
  return client;
}

/** @deprecated Use `resetSupabaseClient()`. */
export function clearAuthenticatedClientCache(_walletAddress?: string): void {
  resetSupabaseClient();
}
