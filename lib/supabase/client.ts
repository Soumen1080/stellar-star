import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl     = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const _configured = !!(supabaseUrl && supabaseAnonKey);

if (!_configured && typeof window !== "undefined") {
  console.warn(
    "[Stellar Star] Supabase not configured — running in offline/demo mode. " +
    "Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local to enable cloud sync."
  );
}

/** Returns true when Supabase env vars are present and the client is usable. */
export function isSupabaseConfigured(): boolean {
  return _configured;
}

export const supabase: SupabaseClient | null = _configured
  ? createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } },
    })
  : null;

export function createAuthenticatedClient(walletAddress: string): SupabaseClient {
  if (!_configured) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
    );
  }
  if (!walletAddress) throw new Error("Wallet address is required for authenticated requests");
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
    global: { headers: { "x-wallet-address": walletAddress } },
  });
}
