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

import { Asset } from "@stellar/stellar-sdk";

/** A classic Stellar asset. `issuer: null` means the native asset (XLM). */
export interface AssetRef {
  code: string;
  issuer: string | null;
}

/** An asset plus the presentation and policy facts the app needs about it. */
export interface AssetDef extends AssetRef {
  /** Human label, e.g. "USDC". */
  name: string;
  /** Decimals to show in the UI. Classic assets settle at 7 regardless. */
  displayDecimals: number;
  /** True for the network's native asset. */
  isNative: boolean;
  /** True when this is an issuer the app vouches for by name. */
  trusted: boolean;
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

export const NATIVE_ASSET: AssetRef = { code: "XLM", issuer: null };

function registry(network: StellarNetwork): AssetDef[] {
  const usdcIssuer =
    network === "PUBLIC" ? CIRCLE_USDC_ISSUER_PUBLIC : CIRCLE_USDC_ISSUER_TESTNET;

  return [
    {
      code: "XLM",
      issuer: null,
      name: "Lumens",
      displayDecimals: 7,
      isNative: true,
      trusted: true,
    },
    {
      code: "USDC",
      issuer: usdcIssuer,
      name: "USD Coin",
      displayDecimals: 2,
      isNative: false,
      trusted: true,
    },
  ];
}

function defaultNetwork(): StellarNetwork {
  return process.env.NEXT_PUBLIC_STELLAR_NETWORK === "PUBLIC" ? "PUBLIC" : "TESTNET";
}

/** The assets this deployment knows by name. */
export function getAssetRegistry(net: StellarNetwork = defaultNetwork()): AssetDef[] {
  return registry(net);
}

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

/** Parses the canonical string form back into an `AssetRef`. */
export function parseAssetKey(s: string): AssetRef {
  const trimmed = s.trim();
  if (trimmed === NATIVE_ASSET_KEY || trimmed.toUpperCase() === "XLM") {
    return { ...NATIVE_ASSET };
  }

  const separator = trimmed.indexOf(":");
  if (separator <= 0 || separator === trimmed.length - 1) {
    throw new Error(`Malformed asset key: ${s}. Expected "native" or "CODE:ISSUER".`);
  }

  return {
    code: trimmed.slice(0, separator),
    issuer: trimmed.slice(separator + 1),
  };
}

/** True for the native asset. */
export function isNative(ref: AssetRef): boolean {
  return ref.issuer === null && ref.code.toUpperCase() === "XLM";
}

/** Structural equality — code *and* issuer. */
export function assetEquals(a: AssetRef, b: AssetRef): boolean {
  return assetKey(a) === assetKey(b);
}

/** Converts to the SDK's `Asset`, for building operations. */
export function toSdkAsset(ref: AssetRef): Asset {
  if (isNative(ref)) return Asset.native();
  if (!ref.issuer) {
    throw new Error(`Non-native asset ${ref.code} requires an issuer.`);
  }
  return new Asset(ref.code, ref.issuer);
}

/** Converts an SDK `Asset` back to an `AssetRef`. */
export function fromSdkAsset(asset: Asset): AssetRef {
  return asset.isNative()
    ? { ...NATIVE_ASSET }
    : { code: asset.getCode(), issuer: asset.getIssuer() };
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

  return {
    code: ref.code,
    issuer: ref.issuer,
    name: ref.code,
    displayDecimals: CLASSIC_ASSET_DECIMALS,
    isNative: isNative(ref),
    trusted: false,
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
