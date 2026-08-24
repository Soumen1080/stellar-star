/** @jest-environment jsdom */

import crypto from "crypto";
import {
  LS_AUTH_TOKEN,
  decodeClaims,
  getSession,
  getAccessToken,
  getSessionWallet,
  hasSessionFor,
  setSession,
  clearSession,
  subscribe,
  __resetSessionForTests,
} from "@/lib/supabase/session";

const WALLET = "GBTESTWALLETADDRESS000000000000000000000000000000000000";

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

/** Builds a JWT shaped like the one /api/auth/verify mints. */
function mintToken({
  wallet = WALLET,
  expiresInSeconds = 3600,
  sub = "00000000-0000-4000-8000-000000000000",
}: { wallet?: string; expiresInSeconds?: number; sub?: string } = {}): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const payload = base64url(
    JSON.stringify({
      iss: "supabase",
      aud: "authenticated",
      role: "authenticated",
      sub,
      wallet_address: wallet,
      iat: now,
      exp: now + expiresInSeconds,
    })
  );
  const signature = base64url(
    crypto.createHmac("sha256", "test-secret").update(`${header}.${payload}`).digest()
  );
  return `${header}.${payload}.${signature}`;
}

describe("wallet session store", () => {
  beforeEach(() => {
    localStorage.clear();
    __resetSessionForTests();
  });

  describe("decodeClaims", () => {
    it("reads the wallet address and expiry out of a session token", () => {
      const claims = decodeClaims(mintToken());

      expect(claims?.wallet_address).toBe(WALLET);
      expect(claims?.role).toBe("authenticated");
      expect(typeof claims?.exp).toBe("number");
    });

    it("returns null for a token that is not a JWT", () => {
      expect(decodeClaims("not-a-token")).toBeNull();
      expect(decodeClaims("")).toBeNull();
    });

    it("returns null for a JWT carrying no wallet_address claim", () => {
      const header = base64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
      const payload = base64url(JSON.stringify({ sub: "abc", exp: 9999999999 }));

      expect(decodeClaims(`${header}.${payload}.sig`)).toBeNull();
    });
  });

  describe("setSession / getSession", () => {
    it("persists the token and exposes its wallet", () => {
      const token = mintToken();
      setSession(token);

      expect(getAccessToken()).toBe(token);
      expect(getSessionWallet()).toBe(WALLET);
      expect(localStorage.getItem(LS_AUTH_TOKEN)).toBe(token);
    });

    it("rejects a malformed token instead of storing it", () => {
      expect(() => setSession("garbage")).toThrow(/malformed/i);
      expect(localStorage.getItem(LS_AUTH_TOKEN)).toBeNull();
    });

    it("restores a persisted session written before this page load", () => {
      const token = mintToken();
      localStorage.setItem(LS_AUTH_TOKEN, token);

      expect(getSession()?.token).toBe(token);
    });
  });

  describe("expiry", () => {
    it("discards an already-expired persisted token rather than sending it", () => {
      localStorage.setItem(LS_AUTH_TOKEN, mintToken({ expiresInSeconds: -10 }));

      expect(getSession()).toBeNull();
      expect(localStorage.getItem(LS_AUTH_TOKEN)).toBeNull();
    });

    it("treats a token inside the refresh skew as already expired", () => {
      // 30s of life left, less than the 60s skew.
      localStorage.setItem(LS_AUTH_TOKEN, mintToken({ expiresInSeconds: 30 }));

      expect(getAccessToken()).toBeNull();
    });

    it("keeps a token with plenty of life left", () => {
      localStorage.setItem(LS_AUTH_TOKEN, mintToken({ expiresInSeconds: 3600 }));

      expect(getAccessToken()).not.toBeNull();
    });
  });

  describe("hasSessionFor", () => {
    it("is true only for the wallet the session was minted for", () => {
      setSession(mintToken({ wallet: WALLET }));

      expect(hasSessionFor(WALLET)).toBe(true);
      expect(hasSessionFor("GBSOMEOTHERWALLET")).toBe(false);
      expect(hasSessionFor(null)).toBe(false);
    });

    it("is false once the session is cleared", () => {
      setSession(mintToken());
      clearSession();

      expect(hasSessionFor(WALLET)).toBe(false);
      expect(localStorage.getItem(LS_AUTH_TOKEN)).toBeNull();
    });
  });

  describe("subscribe", () => {
    // This is the mechanism that makes data load right after sign-up: the
    // providers re-run their fetch when a session appears.
    it("notifies listeners when a session is created", () => {
      const listener = jest.fn();
      subscribe(listener);

      setSession(mintToken());

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("notifies listeners when a session is cleared", () => {
      setSession(mintToken());
      const listener = jest.fn();
      subscribe(listener);

      clearSession();

      expect(listener).toHaveBeenCalledTimes(1);
    });

    it("does not notify when clearing an already-empty session", () => {
      const listener = jest.fn();
      subscribe(listener);

      clearSession();

      expect(listener).not.toHaveBeenCalled();
    });

    it("stops notifying after unsubscribe", () => {
      const listener = jest.fn();
      const unsubscribe = subscribe(listener);

      unsubscribe();
      setSession(mintToken());

      expect(listener).not.toHaveBeenCalled();
    });
  });
});
