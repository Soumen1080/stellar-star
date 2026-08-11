import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const supabaseUrl     = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";

const _configured = !!(supabaseUrl && supabaseAnonKey);

if (!_configured && typeof window !== "undefined") {
  console.warn(
    "[StellarStar] Supabase not configured - running in offline/demo mode. " +
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

type CachedAuthenticatedClient = {
  client: SupabaseClient;
  token: string;
};

const clientCache = new Map<string, CachedAuthenticatedClient>();

export function clearAuthenticatedClientCache(walletAddress?: string): void {
  if (walletAddress) {
    const cached = clientCache.get(walletAddress);
    if (cached) {
      cached.client.removeAllChannels();
      clientCache.delete(walletAddress);
    }
  } else {
    for (const { client } of clientCache.values()) {
      client.removeAllChannels();
    }
    clientCache.clear();
  }
}

export function createAuthenticatedClient(walletAddress?: string): SupabaseClient {
  if (!_configured) {
    throw new Error(
      "Supabase is not configured. Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local."
    );
  }
  const token = typeof window !== "undefined" ? localStorage.getItem("StellarStar:authToken") : null;
  if (!token) throw new Error("Authentication token is required for authenticated requests");
  
  const key = walletAddress || (typeof window !== "undefined" ? localStorage.getItem("StellarStar:publicKey") : null) || "default";

  const cached = clientCache.get(key);
  if (cached?.token === token) {
    return cached.client;
  }
  if (cached) {
    cached.client.removeAllChannels();
    clientCache.delete(key);
  }

  const client = createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  client.realtime.setAuth(token);
  clientCache.set(key, { client, token });
  return client;
}
