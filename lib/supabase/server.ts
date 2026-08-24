import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";

// Server-only module: it can read the service-role key, which must never reach
// a browser bundle. Guard at runtime rather than depending on the `server-only`
// package so this stays dependency-free.
if (typeof window !== "undefined") {
  throw new Error("lib/supabase/server.ts must not be imported from client code.");
}

export type ServerClient = SupabaseClient<Database>;

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() ?? "";

export function isServerSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey);
}

const BASE_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  // A route handler has no use for a websocket, and leaving realtime idle here
  // would keep a connection open per serverless invocation.
  realtime: { params: { eventsPerSecond: 1 } },
} as const;

/**
 * A client acting as a specific wallet, by presenting the JWT this server just
 * minted for it.
 *
 * This is how /api/auth/verify provisions a user row without needing the
 * service-role key: the request is subject to exactly the same RLS policies as
 * the browser would be, so the server cannot write anything the user could not
 * have written themselves.
 */
export function createServerClientForToken(accessToken: string): ServerClient {
  if (!isServerSupabaseConfigured()) {
    throw new Error(
      "Supabase is not configured on the server. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY."
    );
  }
  return createClient<Database>(supabaseUrl, supabaseAnonKey, {
    ...BASE_OPTIONS,
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** An unauthenticated server client, limited to whatever `anon` may read. */
export function createServerAnonClient(): ServerClient {
  if (!isServerSupabaseConfigured()) {
    throw new Error("Supabase is not configured on the server.");
  }
  return createClient<Database>(supabaseUrl, supabaseAnonKey, BASE_OPTIONS);
}

/**
 * A client that bypasses RLS entirely.
 *
 * Optional — the app works without it. Returns null when
 * SUPABASE_SERVICE_ROLE_KEY is unset, so callers must have a non-admin path.
 * Never import this from anything that reaches the browser bundle.
 */
export function createServiceRoleClient(): ServerClient | null {
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient<Database>(supabaseUrl, serviceRoleKey, BASE_OPTIONS);
}
