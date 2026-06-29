/** @jest-environment jsdom */

import { createAuthenticatedClient, clearAuthenticatedClientCache } from "@/lib/supabase/client";
import { createClient } from "@supabase/supabase-js";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn().mockImplementation(() => ({
    mockClient: true,
  })),
}));

describe("Supabase Client Caching", () => {
  const mockCreateClient = createClient as jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    clearAuthenticatedClientCache();
    // Setup environment variables needed for supabase client initialization
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
    
    // Setup localStorage token
    const store: Record<string, string> = {
      "StellarStar:authToken": "mock-token",
    };
    Object.defineProperty(window, "localStorage", {
      value: {
        getItem: (key: string) => store[key] || null,
        setItem: (key: string, val: string) => { store[key] = val; },
        removeItem: (key: string) => { delete store[key]; },
        clear: () => { for (const k in store) delete store[k]; },
      },
      writable: true,
    });
  });

  afterEach(() => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  });

  it("caches and reuses the client instance for the same wallet address", () => {
    const wallet = "GB123";
    const client1 = createAuthenticatedClient(wallet);
    const client2 = createAuthenticatedClient(wallet);

    expect(client1).toBe(client2);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("returns different client instances for different wallet addresses", () => {
    const walletA = "GB_A";
    const walletB = "GB_B";

    const clientA = createAuthenticatedClient(walletA);
    const clientB = createAuthenticatedClient(walletB);

    expect(clientA).not.toBe(clientB);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("clears the client cache on clearAuthenticatedClientCache", () => {
    const wallet = "GB123";
    const client1 = createAuthenticatedClient(wallet);
    
    clearAuthenticatedClientCache(wallet);
    
    const client2 = createAuthenticatedClient(wallet);

    expect(client1).not.toBe(client2);
    expect(mockCreateClient).toHaveBeenCalledTimes(2);
  });

  it("clears the entire cache when no wallet address is provided to clearAuthenticatedClientCache", () => {
    const walletA = "GB_A";
    const walletB = "GB_B";

    const clientA1 = createAuthenticatedClient(walletA);
    const clientB1 = createAuthenticatedClient(walletB);

    clearAuthenticatedClientCache();

    const clientA2 = createAuthenticatedClient(walletA);
    const clientB2 = createAuthenticatedClient(walletB);

    expect(clientA1).not.toBe(clientA2);
    expect(clientB1).not.toBe(clientB2);
    expect(mockCreateClient).toHaveBeenCalledTimes(4);
  });
});
