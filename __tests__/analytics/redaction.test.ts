import {
  containsSensitiveData,
  sanitizeAnalyticsPayload,
  sanitizeAnalyticsEvent,
  SENSITIVE_PATTERNS,
} from "@/lib/analytics/redaction";
import { type AnalyticsEvent } from "@/lib/analytics/types";

describe("Analytics Redaction Engine", () => {
  const DUMMY_PUBKEY = "GDQAXCC66ZI3RLPA72TTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5LV";
  const DUMMY_SECRET = "SBV4C2FKYEZW6RPA66YQTTWGI2MN6K4LH3JEM6NKXKR7LPJ3R7OYIJF5";
  const DUMMY_XDR = "AAAAAGLZd5pU61+Nn8+5H4k7HspgN1p5rR02b2YpAAAAAAAAAAAAAAABAAAAAAAAAAAAAAA=";
  const DUMMY_RECEIPT_BLOB = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

  describe("containsSensitiveData detector", () => {
    it("detects Stellar public keys", () => {
      expect(containsSensitiveData(DUMMY_PUBKEY)).toBe(true);
      expect(containsSensitiveData({ user: DUMMY_PUBKEY })).toBe(true);
    });

    it("detects Stellar secret keys", () => {
      expect(containsSensitiveData(DUMMY_SECRET)).toBe(true);
      expect(containsSensitiveData({ key: DUMMY_SECRET })).toBe(true);
    });

    it("detects transaction XDR payloads", () => {
      expect(containsSensitiveData(DUMMY_XDR)).toBe(true);
      expect(containsSensitiveData({ tx_xdr: DUMMY_XDR })).toBe(true);
    });

    it("detects receipt file data and base64 blobs", () => {
      expect(containsSensitiveData(DUMMY_RECEIPT_BLOB)).toBe(true);
    });

    it("detects forbidden key names like walletAddress, description, memo", () => {
      expect(containsSensitiveData({ walletAddress: "some-val" })).toBe(true);
      expect(containsSensitiveData({ description: "Dinner with friends" })).toBe(true);
      expect(containsSensitiveData({ memo: "Secret trip note" })).toBe(true);
      expect(containsSensitiveData({ receipt_ocr: "1x Ramen $15" })).toBe(true);
    });

    it("returns false for clean, non-sensitive payloads", () => {
      expect(containsSensitiveData({ currency: "XLM", member_count: 3 })).toBe(false);
      expect(containsSensitiveData({ wallet_type: "freighter", network: "TESTNET" })).toBe(false);
      expect(containsSensitiveData({ split_mode: "equal" })).toBe(false);
    });
  });

  describe("sanitizeAnalyticsPayload", () => {
    it("strips unwhitelisted and sensitive keys", () => {
      const raw = {
        currency: "XLM",
        walletAddress: DUMMY_PUBKEY,
        memo: "Dinner payment",
        title: "Weekend Trip",
        unauthorizedField: "secret",
      };

      const sanitized = sanitizeAnalyticsPayload("expense_create_started", raw as any);
      expect(sanitized).toEqual({ currency: "XLM" });
      expect((sanitized as any).walletAddress).toBeUndefined();
      expect((sanitized as any).memo).toBeUndefined();
      expect((sanitized as any).title).toBeUndefined();
      expect((sanitized as any).unauthorizedField).toBeUndefined();
    });

    it("redacts sensitive patterns if embedded in strings", () => {
      const raw = {
        wallet_type: `freighter-${DUMMY_PUBKEY}`,
      };

      const sanitized = sanitizeAnalyticsPayload("wallet_connect_started", raw as any);
      expect(sanitized.wallet_type).toContain("[REDACTED_ADDRESS]");
      expect(sanitized.wallet_type).not.toContain(DUMMY_PUBKEY);
    });
  });

  describe("sanitizeAnalyticsEvent envelope", () => {
    it("ensures session and root envelope are clean", () => {
      const event: AnalyticsEvent = {
        id: "123",
        name: "wallet_connected",
        schemaVersion: "1.0.0",
        timestamp: new Date().toISOString(),
        properties: {
          wallet_type: "freighter",
          network: "TESTNET",
          has_funds: true,
          // Intentionally trying to leak wallet address:
          publicKey: DUMMY_PUBKEY,
        } as any,
        session: {
          id: "session-abc",
          locale: "en-US",
        },
      };

      const sanitized = sanitizeAnalyticsEvent(event);
      expect(sanitized.properties.wallet_type).toBe("freighter");
      expect((sanitized.properties as any).publicKey).toBeUndefined();
      expect(containsSensitiveData(sanitized)).toBe(false);
    });
  });
});
