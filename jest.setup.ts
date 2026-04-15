import { TextDecoder, TextEncoder } from "util";

// Jest does not auto-load Next.js .env.local, so provide safe defaults for tests.
if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
}
if (!process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "test-anon-key";
}
if (!process.env.NEXT_PUBLIC_CONTRACT_ID) {
  process.env.NEXT_PUBLIC_CONTRACT_ID = "CTestContractIdForJest";
}

if (!(global as any).TextEncoder) {
  (global as any).TextEncoder = TextEncoder;
}

if (!(global as any).TextDecoder) {
  (global as any).TextDecoder = TextDecoder as unknown as typeof global.TextDecoder;
}
