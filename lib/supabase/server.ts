import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/types/supabase";
import { publicEnv } from "@/lib/config/publicEnv";
import { serverEnv } from "@/lib/config/serverEnv";

// Server-only module: it can read the service-role key, which must never reach
// a browser bundle. Guard at runtime rather than depending on the `server-only`
// package so this stays dependency-free.
  if (typeof window !== "undefined") {
  throw new Error("lib/supabase/server.ts must not be imported from client code.");
}

export type ServerClient = SupabaseClient<Database>;

const supabaseUrl = publicEnv.supabaseUrl?.trim() ?? "";
const supabaseAnonKey = publicEnv.supabaseAnonKey?.trim() ?? "";
const serviceRoleKey = serverEnv.supabaseServiceRoleKey?.trim() ?? "";

export function isServerSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseAnonKey) && process.env.NODE_ENV !== "test";
}

const BASE_OPTIONS = {
  auth: {
    persistSession: false,
    autoRefreshToken: false,
    detectSessionInUrl: false,
  },
  realtime: { params: { eventsPerSecond: 1 } },
} as const;

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

export function createServerAnonClient(): ServerClient {
  if (!isServerSupabaseConfigured()) {
    throw new Error("Supabase is not configured on the server.");
  }
  return createClient<Database>(supabaseUrl, supabaseAnonKey, BASE_OPTIONS);
}

export function createServiceRoleClient(): ServerClient | null {
  if (!supabaseUrl || !serviceRoleKey) return null;
  return createClient<Database>(supabaseUrl, serviceRoleKey, BASE_OPTIONS);
}