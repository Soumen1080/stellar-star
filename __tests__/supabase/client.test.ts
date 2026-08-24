/** @jest-environment jsdom */

import { createClient } from "@supabase/supabase-js";

jest.mock("@supabase/supabase-js", () => ({
  createClient: jest.fn(() => ({
    mockClient: true,
    removeAllChannels: jest.fn().mockResolvedValue([]),
    realtime: { setAuth: jest.fn() },
  })),
}));

const mockCreateClient = createClient as jest.Mock;

/**
 * The client is a module-level singleton, so each test re-imports the module
 * to get a clean one.
 */
function loadClientModule() {
  let mod: typeof import("@/lib/supabase/client");
  let session: typeof import("@/lib/supabase/session");
  jest.isolateModules(() => {
    session = require("@/lib/supabase/session");
    mod = require("@/lib/supabase/client");
  });
  return { client: mod!, session: session! };
}

describe("Supabase browser client", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    localStorage.clear();
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  });

  it("reports configured when both env vars are present", () => {
    const { client } = loadClientModule();
    expect(client.isSupabaseConfigured()).toBe(true);
  });

  it("reports not configured when the env vars are missing", () => {
    delete process.env.NEXT_PUBLIC_SUPABASE_URL;
    delete process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

    const { client } = loadClientModule();

    expect(client.isSupabaseConfigured()).toBe(false);
    expect(client.getSupabaseClient()).toBeNull();
    expect(() => client.requireSupabaseClient()).toThrow(/not configured/i);
  });

  it("returns one shared client rather than one per wallet", () => {
    // Identity travels on the JWT, not on the client instance, so a second
    // wallet does not need (and must not silently get) a second socket.
    const { client } = loadClientModule();

    const first = client.getSupabaseClient();
    const second = client.getSupabaseClient();

    expect(first).toBe(second);
    expect(mockCreateClient).toHaveBeenCalledTimes(1);
  });

  it("wires an accessToken resolver instead of a baked-in Authorization header", () => {
    const { client } = loadClientModule();
    client.getSupabaseClient();

    const options = mockCreateClient.mock.calls[0][2];

    expect(typeof options.accessToken).toBe("function");
    expect(options.global?.headers?.Authorization).toBeUndefined();
  });

  it("resolves the current token on every request, so a renewed token is picked up", async () => {
    const { client, session } = loadClientModule();
    client.getSupabaseClient();
    const { accessToken } = mockCreateClient.mock.calls[0][2];

    expect(await accessToken()).toBeNull();

    const first = mintToken("GBWALLET_A");
    session.setSession(first);
    expect(await accessToken()).toBe(first);

    const renewed = mintToken("GBWALLET_A");
    session.setSession(renewed);
    expect(await accessToken()).toBe(renewed);
  });

  it("refuses an authenticated request when there is no session", () => {
    const { client } = loadClientModule();

    expect(() => client.requireAuthenticatedClient()).toThrow(/sign in/i);
  });

  it("allows an authenticated request once a session exists", () => {
    const { client, session } = loadClientModule();
    session.setSession(mintToken("GBWALLET_A"));

    expect(() => client.requireAuthenticatedClient()).not.toThrow();
  });

  it("tears down channels and drops the session on reset", () => {
    const { client, session } = loadClientModule();
    session.setSession(mintToken("GBWALLET_A"));
    const instance = client.getSupabaseClient() as any;

    client.resetSupabaseClient();

    expect(instance.removeAllChannels).toHaveBeenCalled();
    expect(session.getAccessToken()).toBeNull();
  });
});

function mintToken(wallet: string): string {
  const b64 = (value: string) =>
    Buffer.from(value).toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
  const now = Math.floor(Date.now() / 1000);
  const header = b64(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = b64(
    JSON.stringify({
      role: "authenticated",
      sub: wallet,
      wallet_address: wallet,
      iat: now,
      exp: now + 3600,
      // Distinguishes two tokens minted in the same second.
      jti: Math.random().toString(36).slice(2),
    })
  );
  return `${header}.${payload}.signature`;
}
