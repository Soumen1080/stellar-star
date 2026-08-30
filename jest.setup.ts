import { TextDecoder, TextEncoder } from "util";

// Jest does not auto-load Next.js .env.local, so provide safe defaults for tests.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
}
if (!process.env.NEXT_PUBLIC_CONTRACT_ID) {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "CBS2BJQ4ZC2ZSAZ5XS47BGC6Q7VTMJA4SE2PVHFXGXAZI5ES6H645WHO";
}
if (!process.env.SUPABASE_JWT_SECRET) {
  process.env.SUPABASE_JWT_SECRET = "test-only-jwt-secret-not-used-in-production";
}
if (!process.env.NEXT_PUBLIC_STELLAR_NETWORK) {
  process.env.NEXT_PUBLIC_STELLAR_NETWORK = "TESTNET";
}
if (!process.env.NEXT_PUBLIC_SOROBAN_RPC_URL) {
  process.env.NEXT_PUBLIC_SOROBAN_RPC_URL = "https://soroban-testnet.stellar.org";
}
if (!process.env.NEXT_PUBLIC_HORIZON_URL) {
  process.env.NEXT_PUBLIC_HORIZON_URL = "https://horizon-testnet.stellar.org";
}

if (!(global as any).TextEncoder) {
  (global as any).TextEncoder = TextEncoder;
}

if (!(global as any).TextDecoder) {
  (global as any).TextDecoder = TextDecoder as unknown as typeof global.TextDecoder;
}

import * as fc from "fast-check";
if (process.env.FC_SEED) {
  const seed = parseInt(process.env.FC_SEED, 10);
  if (!isNaN(seed)) {
    fc.configureGlobal({ seed });
    console.log(`[Fast-Check] Configured global seed: ${seed}`);
  }
}
