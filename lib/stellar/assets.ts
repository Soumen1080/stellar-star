/**
 * Seam S1 — asset identity.
 *
 * The rule this module exists to enforce: **an asset is a (code, issuer) pair,
 * never a code alone.** Anyone can issue a token called "USDC"; only one issuer
 * is Circle's. Comparing codes is not a shortcut, it is a way to pay a
 * counterfeit.
 *
 * Every classic Stellar asset uses exactly 7 decimals — amounts are int64
 * stroops protocol-wide. That is assumed throughout this module and stated
 * where it matters. It is *not* true of arbitrary Soroban tokens, which declare
 * their own `decimals()`.
 */

import { Asset, StrKey, xdr } from "@stellar/stellar-sdk";

export type AssetType = "native" | "credit_alphanum4" | "credit_alphanum12";

/** A classic Stellar asset. `issuer: null` means the native asset (XLM). */
export interface AssetRef {
  code: string;
  issuer: string | null;
}

/** Issuer flags per Stellar protocol (SEP-0011 / account flags). */
export interface AssetFlags {
  /** Issuer must authorize trustlines before an account can receive the asset. */
  authRequired: boolean;
  /** Issuer can freeze or revoke trustlines. */
  authRevocable: boolean;
  /** Issuer flags cannot be changed in the future. */
  authImmutable: boolean;
  /** Issuer can claw back balances (AUTH_CLAWBACK_ENABLED). */
  clawbackEnabled: boolean;
}

/** An asset plus the presentation and policy facts the app needs about it. */
export interface AssetDef extends AssetRef {
  /** Human label, e.g. "USDC". */
  name: string;
  /** Decimals to show in the UI. Classic assets settle at 7 regardless. */
  displayDecimals: number;
  /** Decimal precision for settlement arithmetic (7 for classic, custom for Soroban tokens). */
  decimals: number;
  /** True for the network's native asset. */
  isNative: boolean;
  /** True when this is an issuer the app vouches for by name. */
  trusted: boolean;
  /** The Stellar asset type classification. */
  assetType: AssetType;
  /** Issuer policy flags when known. */
  flags?: Partial<AssetFlags>;
}

export type StellarNetwork = "TESTNET" | "PUBLIC";

/**
 * Circle's USDC issuers, per the epic's stated constraints. These two values
 * are the whole reason `assetKey` includes the issuer.
 */
export const CIRCLE_USDC_ISSUER_TESTNET =
  "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
export const CIRCLE_USDC_ISSUER_PUBLIC =
  "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

/** All classic Stellar assets carry exactly 7 decimals. */
export const CLASSIC_ASSET_DECIMALS = 7;

/** The canonical key for the native asset. */
export const NATIVE_ASSET_KEY = "native";

export const NATIVE_ASSET: Readonly<AssetRef> = Object.freeze({
  code: "XLM",
  issuer: null,
});

/** Bitmasks for Stellar account / asset issuer flags. */
export const AUTH_REQUIRED_FLAG = 0x1;
export const AUTH_REVOCABLE_FLAG = 0x2;
export const AUTH_IMMUTABLE_FLAG = 0x4;
export const AUTH_CLAWBACK_ENABLED_FLAG = 0x8;

// ── Validation Helpers ────────────────────────────────────────────────────────

const ASSET_CODE_REGEX = /^[a-zA-Z0-9]+$/;

/** True if code is 1–4 alphanumeric characters (credit_alphanum4). */
export function isAlphanum4(code: string): boolean {
  return typeof code === "string" && code.length >= 1 && code.length <= 4 && ASSET_CODE_REGEX.test(code);
}

/** True if code is 5–12 alphanumeric characters (credit_alphanum12). */
export function isAlphanum12(code: string): boolean {
  return typeof code === "string" && code.length >= 5 && code.length <= 12 && ASSET_CODE_REGEX.test(code);
}

/** True if code is a valid classic Stellar asset code (1–12 alphanumeric characters). */
export function isValidAssetCode(code: string): boolean {
  return isAlphanum4(code) || isAlphanum12(code);
}

/** True if issuer is a valid Ed25519 public key (or null for native). */
export function isValidIssuer(issuer: string | null, isNative = false): boolean {
  if (isNative) return issuer === null;
  if (!issuer || typeof issuer !== "string") return false;
  return StrKey.isValidEd25519PublicKey(issuer);
}

/** Returns the asset type for an AssetRef. */
export function getAssetType(ref: AssetRef): AssetType {
  if (isNative(ref)) return "native";
  if (isAlphanum4(ref.code)) return "credit_alphanum4";
  if (isAlphanum12(ref.code)) return "credit_alphanum12";
  throw new Error(`Invalid asset code "${ref.code}". Asset codes must be 1-12 alphanumeric characters.`);
}

/** Validates whether an object is a well-formed AssetRef. */
export function validateAssetRef(ref: unknown): { valid: boolean; error?: string } {
  if (!ref || typeof ref !== "object") {
    return { valid: false, error: "Asset reference must be an object." };
  }
  const { code, issuer } = ref as Partial<AssetRef>;
  if (typeof code !== "string" || code.trim() === "") {
    return { valid: false, error: "Asset code must be a non-empty string." };
  }
  if (issuer === null) {
    if (code.toUpperCase() !== "XLM") {
      return { valid: false, error: `Non-native asset "${code}" requires a valid issuer.` };
    }
    return { valid: true };
  }
  if (!isValidAssetCode(code)) {
    return { valid: false, error: `Asset code "${code}" is invalid (must be 1-12 alphanumeric characters).` };
  }
  if (!isValidIssuer(issuer)) {
    return { valid: false, error: `Asset issuer "${issuer}" is not a valid Stellar public key.` };
  }
  return { valid: true };
}

// ── Flag Parsing & Helpers ────────────────────────────────────────────────────

/** Parses numeric issuer flags from a Horizon account or ledger entry into structured flags. */
export function parseIssuerFlags(flags: number): AssetFlags {
  return {
    authRequired: (flags & AUTH_REQUIRED_FLAG) !== 0,
    authRevocable: (flags & AUTH_REVOCABLE_FLAG) !== 0,
    authImmutable: (flags & AUTH_IMMUTABLE_FLAG) !== 0,
    clawbackEnabled: (flags & AUTH_CLAWBACK_ENABLED_FLAG) !== 0,
  };
}

/** True when the asset or issuer has clawback enabled. */
export function isClawbackEnabled(asset: AssetDef | AssetRef | Partial<AssetFlags>): boolean {
  if ("clawbackEnabled" in asset && typeof asset.clawbackEnabled === "boolean") {
    return asset.clawbackEnabled;
  }
  if ("flags" in asset && asset.flags?.clawbackEnabled !== undefined) {
    return asset.flags.clawbackEnabled;
  }
  return false;
}

/** True when the asset or issuer requires trustlines to be authorized. */
export function isAuthRequired(asset: AssetDef | AssetRef | Partial<AssetFlags>): boolean {
  if ("authRequired" in asset && typeof asset.authRequired === "boolean") {
    return asset.authRequired;
  }
  if ("flags" in asset && asset.flags?.authRequired !== undefined) {
    return asset.flags.authRequired;
  }
  return false;
}

// ── Registry & Network Resolution ─────────────────────────────────────────────

function defaultNetwork(): StellarNetwork {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === "PUBLIC" ? "PUBLIC" : "TESTNET";
}

function parseCustomAssetsEnv(): AssetDef[] {
  const envVal = process.env.NEXT_PUBLIC_STELLAR_ASSETS ?? process.env.STELLAR_CUSTOM_ASSETS;
  if (!envVal || envVal.trim() === "") return [];

  try {
    const parsed = JSON.parse(envVal);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const { code, issuer, name, displayDecimals, trusted, decimals, flags } = item;
          if (!code || !isValidAssetCode(code)) return null;
          const native = issuer === null && code.toUpperCase() === "XLM";
          if (!native && !isValidIssuer(issuer)) return null;
          const assetType = native ? "native" : (isAlphanum4(code) ? "credit_alphanum4" : "credit_alphanum12");
          return {
            code,
            issuer: native ? null : issuer,
            name: name ?? code,
            displayDecimals: typeof displayDecimals === "number" ? displayDecimals : CLASSIC_ASSET_DECIMALS,
            decimals: typeof decimals === "number" ? decimals : CLASSIC_ASSET_DECIMALS,
            isNative: native,
            trusted: trusted ?? true,
            assetType,
            flags,
          } as AssetDef;
        })
        .filter((a): a is AssetDef => a !== null);
    }
  } catch {
    // Attempt comma-separated parse: CODE:ISSUER,CODE:ISSUER
    const items = envVal.split(",");
    const custom: AssetDef[] = [];
    for (const item of items) {
      const trimmed = item.trim();
      const parsed = tryParseAssetKey(trimmed);
      if (parsed) {
        custom.push({
          code: parsed.code,
          issuer: parsed.issuer,
          name: parsed.code,
          displayDecimals: CLASSIC_ASSET_DECIMALS,
          decimals: CLASSIC_ASSET_DECIMALS,
          isNative: isNative(parsed),
          trusted: true,
          assetType: getAssetType(parsed),
        });
      }
    }
    return custom;
  }
  return [];
}

function registry(network: StellarNetwork): AssetDef[] {
  const envUsdc = process.env.NEXT_PUBLIC_USDC_ISSUER?.trim();
  const defaultUsdcIssuer =
    network === "PUBLIC" ? CIRCLE_USDC_ISSUER_PUBLIC : CIRCLE_USDC_ISSUER_TESTNET;
  const usdcIssuer = envUsdc && isValidIssuer(envUsdc) ? envUsdc : defaultUsdcIssuer;

  const base: AssetDef[] = [
    {
      code: "XLM",
      issuer: null,
      name: "Lumens",
      displayDecimals: 7,
      decimals: CLASSIC_ASSET_DECIMALS,
      isNative: true,
      trusted: true,
      assetType: "native",
    },
    {
      code: "USDC",
      issuer: usdcIssuer,
      name: "USD Coin",
      displayDecimals: 2,
      decimals: CLASSIC_ASSET_DECIMALS,
      isNative: false,
      trusted: true,
      assetType: "credit_alphanum4",
    },
  ];

  const custom = parseCustomAssetsEnv();
  for (const item of custom) {
    const key = assetKey(item);
    const existingIdx = base.findIndex((b) => assetKey(b) === key);
    if (existingIdx >= 0) {
      base[existingIdx] = item;
    } else {
      base.push(item);
    }
  }

  return base;
}

/** The assets this deployment knows by name, network-aware with environment overrides. */
export function getAssetRegistry(net: StellarNetwork = defaultNetwork()): AssetDef[] {
  return registry(net);
}

// ── Asset Keys and Serialization ──────────────────────────────────────────────

/**
 * The canonical string form of an asset: `"native"` or `"CODE:ISSUER"`.
 *
 * Used as a map key and for equality. The issuer is always included for
 * non-native assets, so two different "USDC"s never collide.
 */
export function assetKey(ref: AssetRef): string {
  if (isNative(ref)) return NATIVE_ASSET_KEY;
  if (!ref.issuer) {
    throw new Error(`Non-native asset ${ref.code} requires an issuer.`);
  }
  return `${ref.code}:${ref.issuer}`;
}

/**
 * Parses the canonical string form back into an `AssetRef`.
 *
 * Fails explicitly on malformed input — never silently falls back to native.
 */
export function parseAssetKey(s: string): AssetRef {
  if (typeof s !== "string") {
    throw new Error(`Malformed asset key: Expected a string, got ${typeof s}.`);
  }
  const trimmed = s.trim();
  if (trimmed === "") {
    throw new Error('Malformed asset key: Cannot be empty. Expected "native" or "CODE:ISSUER".');
  }
  if (trimmed === NATIVE_ASSET_KEY || trimmed.toUpperCase() === "XLM") {
    return { ...NATIVE_ASSET };
  }

  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`Malformed asset key: "${s}". Expected "native" or "CODE:ISSUER".`);
  }

  const code = trimmed.slice(0, separator);
  const issuer = trimmed.slice(separator + 1);

  if (!isValidAssetCode(code)) {
    throw new Error(
      `Malformed asset key: "${s}". Asset code "${code}" must be 1-12 alphanumeric characters.`,
    );
  }

  if (!isValidIssuer(issuer)) {
    throw new Error(
      `Malformed asset key: "${s}". Issuer "${issuer}" is not a valid 56-character Stellar public key.`,
    );
  }

  return {
    code,
    issuer,
  };
}

/**
 * Safely parses an asset key string into an `AssetRef`, returning `null` on error.
 *
 * Never silently defaults to native.
 */
export function tryParseAssetKey(s: string): AssetRef | null {
  try {
    return parseAssetKey(s);
  } catch {
    return null;
  }
}

/** True for the native asset (XLM with null issuer). */
export function isNative(ref: AssetRef): boolean {
  return ref.issuer === null && ref.code.toUpperCase() === "XLM";
}

/** Structural equality — code *and* issuer. Invariant 1: No code path compares codes alone. */
export function assetEquals(
  a: AssetRef | null | undefined,
  b: AssetRef | null | undefined,
): boolean {
  if (!a || !b) return false;
  try {
    return assetKey(a) === assetKey(b);
  } catch {
    return false;
  }
}

// ── SDK & XDR Conversions ─────────────────────────────────────────────────────

/** Converts to the SDK's `Asset`, for building operations and XDR encoding. */
export function toSdkAsset(ref: AssetRef): Asset {
  if (isNative(ref)) return Asset.native();
  if (!ref.issuer) {
    throw new Error(`Non-native asset ${ref.code} requires an issuer.`);
  }
  if (!isValidAssetCode(ref.code)) {
    throw new Error(`Invalid asset code "${ref.code}". Must be 1-12 alphanumeric characters.`);
  }
  if (!isValidIssuer(ref.issuer)) {
    throw new Error(`Invalid issuer "${ref.issuer}". Must be a valid Stellar public key.`);
  }
  return new Asset(ref.code, ref.issuer);
}

/** Converts an SDK `Asset` back to an `AssetRef`. */
export function fromSdkAsset(asset: Asset): AssetRef {
  return asset.isNative()
    ? { ...NATIVE_ASSET }
    : { code: asset.getCode(), issuer: asset.getIssuer() };
}

/** Converts an `AssetRef` to a base64 XDR string. */
export function toXdr(ref: AssetRef): string {
  const sdkAsset = toSdkAsset(ref);
  return sdkAsset.toXDRObject().toXDR("base64");
}

/** Converts a base64 XDR string back to an `AssetRef`. */
export function fromXdr(xdrString: string): AssetRef {
  if (!xdrString || typeof xdrString !== "string") {
    throw new Error("Invalid XDR string: Expected non-empty base64 string.");
  }
  const xdrAsset = xdr.Asset.fromXDR(xdrString, "base64");
  const sdkAsset = Asset.fromOperation(xdrAsset);
  return fromSdkAsset(sdkAsset);
}

/**
 * Builds an `AssetRef` from Horizon's operation fields, which name assets as
 * `{asset_type, asset_code, asset_issuer}` with a `native` type rather than a
 * null issuer.
 */
export function fromHorizonFields(
  assetType: string | undefined,
  assetCode?: string | null,
  assetIssuer?: string | null,
): AssetRef {
  if (assetType === "native") return { ...NATIVE_ASSET };
  if (!assetCode || !assetIssuer) {
    throw new Error("Horizon asset fields are missing a code or issuer.");
  }
  return { code: assetCode, issuer: assetIssuer };
}

/**
 * Resolves an asset to its registry entry, or synthesises one.
 *
 * An asset absent from the registry is returned with `trusted: false` rather
 * than rejected — the app can still handle it, but nothing should present it as
 * a known-good issuer on the strength of its code.
 */
export function resolveAsset(
  ref: AssetRef,
  net: StellarNetwork = defaultNetwork(),
): AssetDef {
  const key = assetKey(ref);
  const known = getAssetRegistry(net).find((a) => assetKey(a) === key);
  if (known) return known;

  const native = isNative(ref);
  const assetType: AssetType = native
    ? "native"
    : isAlphanum4(ref.code)
    ? "credit_alphanum4"
    : "credit_alphanum12";

  return {
    code: ref.code,
    issuer: ref.issuer,
    name: ref.code,
    displayDecimals: CLASSIC_ASSET_DECIMALS,
    decimals: CLASSIC_ASSET_DECIMALS,
    isNative: native,
    trusted: false,
    assetType,
  };
}

/** Short display label: the code, plus a truncated issuer when untrusted. */
export function formatAssetLabel(
  ref: AssetRef,
  net: StellarNetwork = defaultNetwork(),
): string {
  const def = resolveAsset(ref, net);
  if (def.isNative || def.trusted) return def.code;
  const issuer = ref.issuer ?? "";
  return `${def.code} (${issuer.slice(0, 4)}…${issuer.slice(-4)})`;
}
