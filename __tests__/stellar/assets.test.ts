/**
 * Tests for Seam S1 — Asset abstraction and protocol edge cases (Issue #148 / Issue #46).
 */

import {
  AssetDef,
  AssetRef,
  CIRCLE_USDC_ISSUER_PUBLIC,
  CIRCLE_USDC_ISSUER_TESTNET,
  CLASSIC_ASSET_DECIMALS,
  NATIVE_ASSET,
  NATIVE_ASSET_KEY,
  assetEquals,
  assetKey,
  formatAssetLabel,
  fromHorizonFields,
  fromSdkAsset,
  fromXdr,
  getAssetRegistry,
  getAssetType,
  isAlphanum12,
  isAlphanum4,
  isAuthRequired,
  isClawbackEnabled,
  isNative,
  isValidAssetCode,
  isValidIssuer,
  parseAssetKey,
  parseIssuerFlags,
  resolveAsset,
  toSdkAsset,
  toXdr,
  tryParseAssetKey,
  validateAssetRef,
} from "@/lib/stellar/assets";
import { Asset, Keypair } from "@stellar/stellar-sdk";

const ISSUER_A = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const ISSUER_B = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const COUNTERFEIT_ISSUER = "GDQNY3PBOJOKYZSRMK2S7LHHGWZIUISD4QORETLMXEWXBI7KFZZMKTL3";

const BASE_ENV = { ...process.env };

describe("Seam S1: Asset Abstraction", () => {
  beforeEach(() => {
    process.env = { ...BASE_ENV };
    delete process.env.NEXT_PUBLIC_STELLAR_NETWORK;
    delete process.env.NEXT_PUBLIC_USDC_ISSUER;
    delete process.env.NEXT_PUBLIC_STELLAR_ASSETS;
    delete process.env.STELLAR_CUSTOM_ASSETS;
  });

  afterEach(() => {
    process.env = { ...BASE_ENV };
  });

  // ===========================================================================
  // Invariant 1: Asset identity is (code, issuer). No code path compares codes alone.
  // ===========================================================================
  describe("Invariant 1: Identity is (code, issuer)", () => {
    it("treats same code with different issuers as distinct assets", () => {
      const circleUsdc: AssetRef = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_PUBLIC };
      const fakeUsdc: AssetRef = { code: "USDC", issuer: COUNTERFEIT_ISSUER };

      expect(assetEquals(circleUsdc, fakeUsdc)).toBe(false);
      expect(assetKey(circleUsdc)).not.toBe(assetKey(fakeUsdc));
    });

    it("treats identical code and issuer as equal", () => {
      const a: AssetRef = { code: "USDC", issuer: ISSUER_A };
      const b: AssetRef = { code: "USDC", issuer: ISSUER_A };

      expect(assetEquals(a, b)).toBe(true);
      expect(assetKey(a)).toBe(assetKey(b));
    });

    it("native asset has no issuer and is never equal to an issued XLM asset", () => {
      const native = NATIVE_ASSET;
      const issuedXlm: AssetRef = { code: "XLM", issuer: ISSUER_A };

      expect(isNative(native)).toBe(true);
      expect(isNative(issuedXlm)).toBe(false);
      expect(assetEquals(native, issuedXlm)).toBe(false);
      expect(assetKey(native)).toBe("native");
      expect(assetKey(issuedXlm)).toBe(`XLM:${ISSUER_A}`);
    });

    it("returns false for null or undefined asset comparisons", () => {
      const a: AssetRef = { code: "USDC", issuer: ISSUER_A };
      expect(assetEquals(a, null)).toBe(false);
      expect(assetEquals(undefined, a)).toBe(false);
      expect(assetEquals(null, null)).toBe(false);
    });
  });

  // ===========================================================================
  // Invariant 2: Codes of 1–4 and 5–12 characters both round-trip through XDR
  // ===========================================================================
  describe("Invariant 2: Alphanum4 vs Alphanum12 & XDR Roundtripping", () => {
    it("classifies 1 to 4 character codes as credit_alphanum4", () => {
      expect(isAlphanum4("U")).toBe(true);
      expect(isAlphanum4("USD")).toBe(true);
      expect(isAlphanum4("USDC")).toBe(true);

      expect(isAlphanum4("USDCE")).toBe(false);
      expect(isAlphanum4("")).toBe(false);

      const ref4: AssetRef = { code: "USDC", issuer: ISSUER_A };
      expect(getAssetType(ref4)).toBe("credit_alphanum4");

      const sdkAsset4 = toSdkAsset(ref4);
      expect(sdkAsset4.getAssetType()).toBe("credit_alphanum4");
    });

    it("classifies 5 to 12 character codes as credit_alphanum12", () => {
      expect(isAlphanum12("USDCE")).toBe(true);
      expect(isAlphanum12("STELLAR")).toBe(true);
      expect(isAlphanum12("AQUATOKEN")).toBe(true);
      expect(isAlphanum12("TWELVECHAR12")).toBe(true);

      expect(isAlphanum12("USDC")).toBe(false);
      expect(isAlphanum12("THIRTEENCHARS")).toBe(false);

      const ref12: AssetRef = { code: "STELLAR", issuer: ISSUER_A };
      expect(getAssetType(ref12)).toBe("credit_alphanum12");

      const sdkAsset12 = toSdkAsset(ref12);
      expect(sdkAsset12.getAssetType()).toBe("credit_alphanum12");
    });

    it("round-trips alphanum4 asset through XDR correctly", () => {
      const ref: AssetRef = { code: "USDC", issuer: ISSUER_A };
      const xdrBase64 = toXdr(ref);
      expect(typeof xdrBase64).toBe("string");
      expect(xdrBase64.length).toBeGreaterThan(0);

      const restored = fromXdr(xdrBase64);
      expect(assetEquals(ref, restored)).toBe(true);
      expect(restored.code).toBe("USDC");
      expect(restored.issuer).toBe(ISSUER_A);
    });

    it("round-trips alphanum12 asset through XDR correctly without padding corruption", () => {
      const testCodes = ["USDCE", "STELLAR", "AQUATOKEN", "MYCOIN123456"];
      for (const code of testCodes) {
        const ref: AssetRef = { code, issuer: ISSUER_B };
        const xdrBase64 = toXdr(ref);
        const restored = fromXdr(xdrBase64);

        expect(assetEquals(ref, restored)).toBe(true);
        expect(restored.code).toBe(code);
        expect(restored.issuer).toBe(ISSUER_B);
        expect(getAssetType(restored)).toBe("credit_alphanum12");
      }
    });

    it("round-trips native asset through XDR correctly", () => {
      const xdrBase64 = toXdr(NATIVE_ASSET);
      const restored = fromXdr(xdrBase64);

      expect(isNative(restored)).toBe(true);
      expect(restored.code).toBe("XLM");
      expect(restored.issuer).toBeNull();
    });

    it("round-trips SDK Asset conversions", () => {
      const ref4: AssetRef = { code: "USDC", issuer: ISSUER_A };
      const ref12: AssetRef = { code: "STELLAR", issuer: ISSUER_B };

      expect(fromSdkAsset(toSdkAsset(ref4))).toEqual(ref4);
      expect(fromSdkAsset(toSdkAsset(ref12))).toEqual(ref12);
      expect(fromSdkAsset(toSdkAsset(NATIVE_ASSET))).toEqual(NATIVE_ASSET);
    });
  });

  // ===========================================================================
  // Invariant 3: Trustline authorization flags & distinct outcomes
  // ===========================================================================
  describe("Invariant 3: Authorization Flags & Trustline States", () => {
    it("parses issuer flags accurately from numeric bitmask", () => {
      // 0x1 = AUTH_REQUIRED, 0x2 = AUTH_REVOCABLE, 0x4 = AUTH_IMMUTABLE, 0x8 = AUTH_CLAWBACK_ENABLED
      expect(parseIssuerFlags(0)).toEqual({
        authRequired: false,
        authRevocable: false,
        authImmutable: false,
        clawbackEnabled: false,
      });

      expect(parseIssuerFlags(1)).toEqual({
        authRequired: true,
        authRevocable: false,
        authImmutable: false,
        clawbackEnabled: false,
      });

      expect(parseIssuerFlags(9)).toEqual({
        authRequired: true,
        authRevocable: false,
        authImmutable: false,
        clawbackEnabled: true,
      });

      expect(parseIssuerFlags(15)).toEqual({
        authRequired: true,
        authRevocable: true,
        authImmutable: true,
        clawbackEnabled: true,
      });
    });

    it("detects authRequired on assets", () => {
      const assetWithAuth: AssetDef = {
        code: "REGUSD",
        issuer: ISSUER_A,
        name: "Regulated USD",
        displayDecimals: 2,
        decimals: 7,
        isNative: false,
        trusted: true,
        assetType: "credit_alphanum12",
        flags: { authRequired: true },
      };

      const assetWithoutAuth: AssetDef = {
        code: "USDC",
        issuer: ISSUER_A,
        name: "USDC",
        displayDecimals: 2,
        decimals: 7,
        isNative: false,
        trusted: true,
        assetType: "credit_alphanum4",
        flags: { authRequired: false },
      };

      expect(isAuthRequired(assetWithAuth)).toBe(true);
      expect(isAuthRequired(assetWithoutAuth)).toBe(false);
      expect(isAuthRequired({ authRequired: true } as any)).toBe(true);
    });

    it("detects clawbackEnabled on assets", () => {
      const clawbackAsset: AssetDef = {
        code: "CLAWUSD",
        issuer: ISSUER_A,
        name: "Clawback Token",
        displayDecimals: 2,
        decimals: 7,
        isNative: false,
        trusted: false,
        assetType: "credit_alphanum12",
        flags: { clawbackEnabled: true },
      };

      const standardAsset: AssetDef = {
        code: "USDC",
        issuer: ISSUER_A,
        name: "USDC",
        displayDecimals: 2,
        decimals: 7,
        isNative: false,
        trusted: true,
        assetType: "credit_alphanum4",
      };

      expect(isClawbackEnabled(clawbackAsset)).toBe(true);
      expect(isClawbackEnabled(standardAsset)).toBe(false);
      expect(isClawbackEnabled({ clawbackEnabled: true } as any)).toBe(true);
    });
  });

  // ===========================================================================
  // Invariant 4: assetKey is stable, collision-free, and round-trips through parseAssetKey
  // ===========================================================================
  describe("Invariant 4: assetKey & parseAssetKey round-tripping and stability", () => {
    it("generates stable key for native asset", () => {
      expect(assetKey(NATIVE_ASSET)).toBe("native");
      expect(parseAssetKey("native")).toEqual(NATIVE_ASSET);
      expect(parseAssetKey("XLM")).toEqual(NATIVE_ASSET);
      expect(parseAssetKey("  native  ")).toEqual(NATIVE_ASSET);
    });

    it("generates stable CODE:ISSUER key for non-native assets", () => {
      const ref: AssetRef = { code: "USDC", issuer: ISSUER_A };
      const key = assetKey(ref);
      expect(key).toBe(`USDC:${ISSUER_A}`);

      const parsed = parseAssetKey(key);
      expect(parsed).toEqual(ref);
      expect(assetKey(parsed)).toBe(key);
    });

    it("round-trips alphanum12 asset keys", () => {
      const ref: AssetRef = { code: "AQUATOKEN", issuer: ISSUER_B };
      const key = assetKey(ref);
      expect(key).toBe(`AQUATOKEN:${ISSUER_B}`);

      const parsed = parseAssetKey(key);
      expect(parsed).toEqual(ref);
    });

    it("safely roundtrips with tryParseAssetKey", () => {
      const ref: AssetRef = { code: "USDC", issuer: ISSUER_A };
      const key = assetKey(ref);
      expect(tryParseAssetKey(key)).toEqual(ref);
      expect(tryParseAssetKey("native")).toEqual(NATIVE_ASSET);
    });
  });

  // ===========================================================================
  // Invariant 5: An unknown or malformed asset degrades to a safe, explicit state — never a silent fallback to native
  // ===========================================================================
  describe("Invariant 5: Safe Degradation & Malformed Input Handling", () => {
    it("throws explicitly on empty or whitespace strings in parseAssetKey", () => {
      expect(() => parseAssetKey("")).toThrow(/cannot be empty/i);
      expect(() => parseAssetKey("   ")).toThrow(/cannot be empty/i);
      expect(tryParseAssetKey("")).toBeNull();
    });

    it("throws explicitly on non-string inputs", () => {
      expect(() => parseAssetKey(null as unknown as string)).toThrow(/expected a string/i);
      expect(() => parseAssetKey(123 as unknown as string)).toThrow(/expected a string/i);
      expect(tryParseAssetKey(null as unknown as string)).toBeNull();
    });

    it("throws explicitly on missing issuer in non-native key", () => {
      expect(() => parseAssetKey("USDC")).toThrow(/malformed asset key/i);
      expect(() => parseAssetKey("USDC:")).toThrow(/malformed asset key/i);
      expect(() => parseAssetKey(":ISSUER")).toThrow(/malformed asset key/i);
      expect(tryParseAssetKey("USDC")).toBeNull();
    });

    it("throws explicitly on invalid asset codes (invalid chars or too long)", () => {
      expect(() => parseAssetKey(`TOO_LONG_CODE_13_CHARS:${ISSUER_A}`)).toThrow(/must be 1-12/i);
      expect(() => parseAssetKey(`USD$:${ISSUER_A}`)).toThrow(/must be 1-12/i);
      expect(() => parseAssetKey(`US DC:${ISSUER_A}`)).toThrow(/must be 1-12/i);
      expect(tryParseAssetKey(`USD$:${ISSUER_A}`)).toBeNull();
    });

    it("throws explicitly on invalid issuer public keys", () => {
      expect(() => parseAssetKey("USDC:INVALID_PUBLIC_KEY")).toThrow(/valid 56-character/i);
      expect(() => parseAssetKey("USDC:GSHORTKEY")).toThrow(/valid 56-character/i);
      expect(() => parseAssetKey("USDC:SBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5")).toThrow(/valid 56-character/i);
      expect(tryParseAssetKey("USDC:INVALID")).toBeNull();
    });

    it("throws when serializing non-native AssetRef with missing or invalid issuer", () => {
      expect(() => assetKey({ code: "USDC", issuer: null })).toThrow(/requires an issuer/i);
      expect(() => toSdkAsset({ code: "USDC", issuer: null })).toThrow(/requires an issuer/i);
      expect(() => toSdkAsset({ code: "USDC", issuer: "INVALID" })).toThrow(/invalid issuer/i);
    });

    it("throws on malformed XDR string", () => {
      expect(() => fromXdr("")).toThrow(/invalid xdr string/i);
      expect(() => fromXdr("not-a-valid-xdr")).toThrow();
    });

    it("throws on missing code or issuer in fromHorizonFields", () => {
      expect(() => fromHorizonFields("credit_alphanum4", null, ISSUER_A)).toThrow(/missing a code or issuer/i);
      expect(() => fromHorizonFields("credit_alphanum4", "USDC", null)).toThrow(/missing a code or issuer/i);
    });

    it("resolves unknown assets as untrusted, non-native without falling back to XLM", () => {
      const randomKey = Keypair.random().publicKey();
      const unknownRef: AssetRef = { code: "UNKNOWN", issuer: randomKey };

      const def = resolveAsset(unknownRef);
      expect(def.isNative).toBe(false);
      expect(def.trusted).toBe(false);
      expect(def.code).toBe("UNKNOWN");
      expect(def.issuer).toBe(randomKey);
      expect(def.decimals).toBe(CLASSIC_ASSET_DECIMALS);
    });

    it("validates AssetRef structure thoroughly", () => {
      expect(validateAssetRef(NATIVE_ASSET).valid).toBe(true);
      expect(validateAssetRef({ code: "USDC", issuer: ISSUER_A }).valid).toBe(true);
      expect(validateAssetRef({ code: "AQUATOKEN", issuer: ISSUER_B }).valid).toBe(true);

      expect(validateAssetRef(null).valid).toBe(false);
      expect(validateAssetRef({ code: "", issuer: ISSUER_A }).valid).toBe(false);
      expect(validateAssetRef({ code: "TOOLONGASSETCODE123", issuer: ISSUER_A }).valid).toBe(false);
      expect(validateAssetRef({ code: "USDC", issuer: "BAD_KEY" }).valid).toBe(false);
      expect(validateAssetRef({ code: "USDC", issuer: null }).valid).toBe(false);
    });
  });

  // ===========================================================================
  // Network-Aware Registry with Environment Overrides
  // ===========================================================================
  describe("Registry & Environment Overrides", () => {
    it("returns Testnet USDC issuer by default on TESTNET", () => {
      const registry = getAssetRegistry("TESTNET");
      const usdc = registry.find((a) => a.code === "USDC");

      expect(usdc?.issuer).toBe(CIRCLE_USDC_ISSUER_TESTNET);
      expect(usdc?.trusted).toBe(true);
      expect(usdc?.displayDecimals).toBe(2);
    });

    it("returns Public USDC issuer on PUBLIC network", () => {
      const registry = getAssetRegistry("PUBLIC");
      const usdc = registry.find((a) => a.code === "USDC");

      expect(usdc?.issuer).toBe(CIRCLE_USDC_ISSUER_PUBLIC);
      expect(usdc?.trusted).toBe(true);
    });

    it("respects NEXT_PUBLIC_USDC_ISSUER environment variable override", () => {
      const customUsdc = Keypair.random().publicKey();
      process.env.NEXT_PUBLIC_USDC_ISSUER = customUsdc;

      const registry = getAssetRegistry("TESTNET");
      const usdc = registry.find((a) => a.code === "USDC");

      expect(usdc?.issuer).toBe(customUsdc);
    });

    it("parses custom assets from NEXT_PUBLIC_STELLAR_ASSETS JSON", () => {
      const customIssuer = Keypair.random().publicKey();
      process.env.NEXT_PUBLIC_STELLAR_ASSETS = JSON.stringify([
        {
          code: "EURT",
          issuer: customIssuer,
          name: "Euro Token",
          displayDecimals: 2,
          trusted: true,
        },
      ]);

      const registry = getAssetRegistry("TESTNET");
      const eurt = registry.find((a) => a.code === "EURT");

      expect(eurt).toBeDefined();
      expect(eurt?.issuer).toBe(customIssuer);
      expect(eurt?.name).toBe("Euro Token");
      expect(eurt?.trusted).toBe(true);
    });

    it("parses custom assets from comma-separated string", () => {
      const customIssuer = Keypair.random().publicKey();
      process.env.NEXT_PUBLIC_STELLAR_ASSETS = `EURT:${customIssuer}`;

      const registry = getAssetRegistry("TESTNET");
      const eurt = registry.find((a) => a.code === "EURT");

      expect(eurt).toBeDefined();
      expect(eurt?.issuer).toBe(customIssuer);
      expect(eurt?.trusted).toBe(true);
    });

    it("formats labels: code for native/trusted, truncated issuer for untrusted", () => {
      expect(formatAssetLabel(NATIVE_ASSET)).toBe("XLM");

      const circleUsdc: AssetRef = { code: "USDC", issuer: CIRCLE_USDC_ISSUER_TESTNET };
      expect(formatAssetLabel(circleUsdc, "TESTNET")).toBe("USDC");

      const untrusted: AssetRef = { code: "TOKEN", issuer: ISSUER_A };
      const formatted = formatAssetLabel(untrusted);
      expect(formatted).toBe(`TOKEN (${ISSUER_A.slice(0, 4)}…${ISSUER_A.slice(-4)})`);
    });
  });
});
