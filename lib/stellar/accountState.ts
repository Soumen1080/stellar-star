/**
 * Whether a Stellar account exists, and what it can currently do.
 *
 * A Stellar account does not exist until it is funded. Horizon returns 404 for
 * an unfunded address, which the app previously surfaced as "something failed"
 * — a dead end for exactly the person you most want to onboard: the friend who
 * has never heard of Stellar.
 *
 * This module turns that 404 into a *state* rather than an error, so the UI can
 * offer the next step instead of stopping.
 *
 * ## Reserves
 *
 * Stellar requires a minimum XLM balance that scales with what the account
 * holds: `(2 + subentries) × baseReserve`, where each trustline, offer, and
 * signer is a subentry. At the current 0.5 XLM base reserve that is 1 XLM for a
 * bare account and 1.5 XLM once it has one trustline. XLM below the reserve is
 * locked, not spendable — which is why "has a balance" and "can transact" are
 * different questions.
 */

import { HORIZON_URL } from "@/lib/utils/constants";
import { assetKey, fromHorizonFields, isNative, type AssetRef } from "@/lib/stellar/assets";

/** Stellar's base reserve, in stroops. 0.5 XLM at protocol 19+. Now fetched dynamically. */
export const BASE_RESERVE_STROOPS = 5_000_000n;

let cachedBaseReserveStroops = BASE_RESERVE_STROOPS;
let lastBaseReserveFetch = 0;

/** Fetches the live base reserve from the network, with a 60s cache. */
export async function getNetworkBaseReserve(
  horizonUrl: string = HORIZON_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<bigint> {
  const now = Date.now();
  if (now - lastBaseReserveFetch < 60_000) return cachedBaseReserveStroops;

  try {
    const res = await fetchImpl(`${horizonUrl}/ledgers?order=desc&limit=1`, {
      cache: "no-store",
      headers: { "Cache-Control": "no-cache" },
    });
    if (res.ok) {
      const data = await res.json();
      const val = data._embedded?.records?.[0]?.base_reserve_in_stroops;
      if (val) {
        cachedBaseReserveStroops = BigInt(val);
        lastBaseReserveFetch = now;
      }
    }
  } catch (e) {
    // Silently fallback to cache
  }
  return cachedBaseReserveStroops;
}

/** Every account carries two base reserves before any subentries. */
export const BASE_ACCOUNT_SUBENTRIES = 2n;

const STROOPS_PER_XLM = 10_000_000n;

export type AccountStatus =
  /** No account on the network. Cannot receive anything but a create-account. */
  | "unfunded"
  /** Exists, but every lumen is locked in reserve — cannot pay fees or add trustlines. */
  | "reserve_locked"
  /** Exists and has spendable balance. */
  | "funded";

export interface AccountState {
  publicKey: string;
  status: AccountStatus;
  /** Native balance in stroops. Zero for an unfunded account. */
  balanceStroops: bigint;
  /** Minimum balance this account must retain, in stroops. */
  reserveStroops: bigint;
  /** The live network base reserve used for this calculation. */
  baseReserveStroops: bigint;
  /** Balance above the reserve and liabilities — what can actually be spent. */
  spendableStroops: bigint;
  /** Number of subentries (trustlines, offers, signers). */
  subentryCount: number;
  /** Number of subentries sponsored by someone else. */
  numSponsored: number;
  /** Number of subentries this account is sponsoring. */
  numSponsoring: number;
  /** Assets this account can receive, beyond native. */
  trustlines: TrustlineState[];
  /** True when the account's reserves are paid by a sponsor. */
  sponsored: boolean;
  /** The sponsor's address, when sponsored. */
  sponsorId: string | null;
}

export interface TrustlineState extends AssetRef {
  balanceStroops: bigint;
  limitStroops: bigint;
  buyingLiabilitiesStroops: bigint;
  sellingLiabilitiesStroops: bigint;
  isAuthorized: boolean;
  isAuthorizedToMaintainLiabilities: boolean;
  sponsor?: string;
}

/** Minimum balance for an account, accounting for sponsored reserves. */
export function minimumBalanceStroops(
  subentries: number,
  numSponsoring: number,
  numSponsored: number,
  baseReserveStroops: bigint
): bigint {
  const effectiveEntries = BASE_ACCOUNT_SUBENTRIES + BigInt(subentries) + BigInt(numSponsoring) - BigInt(numSponsored);
  return (effectiveEntries > 0n ? effectiveEntries : 0n) * baseReserveStroops;
}

/**
 * Additional reserve a new trustline would require.
 *
 * The number that makes an empty wallet unable to receive USDC: it is not
 * enough to have an account, you need half a lumen more for each asset you
 * want to hold.
 */
export function trustlineReserveStroops(baseReserveStroops: bigint): bigint {
  return baseReserveStroops;
}

export function stroopsToXlm(stroops: bigint): string {
  const whole = stroops / STROOPS_PER_XLM;
  const fraction = (stroops % STROOPS_PER_XLM).toString().padStart(7, "0");
  return `${whole}.${fraction}`;
}

interface HorizonBalance {
  asset_type?: string;
  asset_code?: string | null;
  asset_issuer?: string | null;
  balance?: string;
  limit?: string;
  buying_liabilities?: string;
  selling_liabilities?: string;
  is_authorized?: boolean;
  is_authorized_to_maintain_liabilities?: boolean;
  sponsor?: string;
}

interface HorizonAccount {
  balances?: HorizonBalance[];
  subentry_count?: number;
  sponsor?: string;
  num_sponsoring?: number;
  num_sponsored?: number;
}

function parseXlm(amount: string): bigint {
  const [whole, fraction = ""] = amount.trim().split(".");
  return BigInt(whole || "0") * STROOPS_PER_XLM + BigInt(fraction.padEnd(7, "0").slice(0, 7) || "0");
}

/**
 * Reads an account's current state.
 *
 * Never throws for a nonexistent account — that is the `unfunded` state, and
 * treating it as an error is what made onboarding a dead end. A genuine Horizon
 * failure still throws, because "we could not check" is not the same as "there
 * is nothing there".
 */
export async function getAccountState(
  publicKey: string,
  horizonUrl: string = HORIZON_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<AccountState> {
  const response = await fetchImpl(`${horizonUrl}/accounts/${publicKey}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });

  const baseReserveStroops = await getNetworkBaseReserve(horizonUrl, fetchImpl);

  if (response.status === 404) {
    return {
      publicKey,
      status: "unfunded",
      balanceStroops: 0n,
      baseReserveStroops,
      reserveStroops: minimumBalanceStroops(0, 0, 0, baseReserveStroops),
      spendableStroops: 0n,
      subentryCount: 0,
      numSponsored: 0,
      numSponsoring: 0,
      trustlines: [],
      sponsored: false,
      sponsorId: null,
    };
  }

  if (!response.ok) {
    throw new Error(
      `Horizon ${response.status}: could not read account ${publicKey}. ` +
        "This is a network problem, not a missing account.",
    );
  }

  const account = (await response.json()) as HorizonAccount;
  const balances = account.balances ?? [];

  const native = balances.find((b) => b.asset_type === "native");
  const balanceStroops = native?.balance ? parseXlm(native.balance) : 0n;
  const nativeSellingLiabilities = native?.selling_liabilities ? parseXlm(native.selling_liabilities) : 0n;

  const subentryCount = account.subentry_count ?? 0;
  const numSponsoring = account.num_sponsoring ?? 0;
  const numSponsored = account.num_sponsored ?? 0;
  const reserveStroops = minimumBalanceStroops(subentryCount, numSponsoring, numSponsored, baseReserveStroops);
  
  const totalLocked = reserveStroops + nativeSellingLiabilities;
  const spendableStroops = balanceStroops > totalLocked ? balanceStroops - totalLocked : 0n;

  const trustlines: TrustlineState[] = balances
    .filter((b) => b.asset_type && b.asset_type !== "native")
    .map((b) => ({
      ...fromHorizonFields(b.asset_type, b.asset_code, b.asset_issuer),
      balanceStroops: parseXlm(b.balance ?? "0"),
      limitStroops: parseXlm(b.limit ?? "0"),
      buyingLiabilitiesStroops: parseXlm(b.buying_liabilities ?? "0"),
      sellingLiabilitiesStroops: parseXlm(b.selling_liabilities ?? "0"),
      isAuthorized: b.is_authorized ?? false,
      isAuthorizedToMaintainLiabilities: b.is_authorized_to_maintain_liabilities ?? false,
      sponsor: b.sponsor,
    }));

  return {
    publicKey,
    status: spendableStroops > 0n ? "funded" : "reserve_locked",
    balanceStroops,
    baseReserveStroops,
    reserveStroops,
    spendableStroops,
    subentryCount,
    numSponsored,
    numSponsoring,
    trustlines,
    sponsored: Boolean(account.sponsor) || numSponsored > 0,
    sponsorId: account.sponsor ?? null,
  };
}

/** True when the account can receive `asset` today. */
export function canReceive(state: AccountState, asset: AssetRef): boolean {
  if (state.status === "unfunded") return false;
  if (isNative(asset)) return true;
  return state.trustlines.some((line) => assetKey(line) === assetKey(asset));
}

export type OnboardingNeed =
  | { kind: "none" }
  /** The account does not exist and must be created. */
  | { kind: "account_creation"; reserveStroops: bigint }
  /** The account exists but needs a trustline. */
  | { kind: "trustline_missing"; asset: AssetRef; reserveStroops: bigint; affordable: boolean }
  /** The trustline exists, but the user is completely unauthorized by the issuer. */
  | { kind: "trustline_unauthorized"; asset: AssetRef; state: TrustlineState }
  /** The trustline exists, but the user is only authorized to maintain liabilities (cannot receive). */
  | { kind: "trustline_auth_maintain"; asset: AssetRef; state: TrustlineState }
  /** The trustline exists, but has insufficient limit capacity to receive more. */
  | { kind: "trustline_at_limit"; asset: AssetRef; state: TrustlineState };

export function describeOnboardingNeed(
  state: AccountState,
  asset: AssetRef,
): OnboardingNeed {
  if (state.status === "unfunded") {
    // A bare account plus one trustline, so the created account can actually
    // hold the asset rather than needing a second top-up immediately.
    const needed = isNative(asset)
      ? minimumBalanceStroops(0, 0, 0, state.baseReserveStroops)
      : minimumBalanceStroops(1, 0, 0, state.baseReserveStroops);
    return { kind: "account_creation", reserveStroops: needed };
  }

  if (isNative(asset)) {
    return { kind: "none" };
  }

  const existing = state.trustlines.find((line) => assetKey(line) === assetKey(asset));

  if (!existing) {
    const needed = trustlineReserveStroops(state.baseReserveStroops);
    return {
      kind: "trustline_missing",
      asset,
      reserveStroops: needed,
      affordable: state.spendableStroops >= needed,
    };
  }

  if (!existing.isAuthorized) {
    if (existing.isAuthorizedToMaintainLiabilities) {
      return { kind: "trustline_auth_maintain", asset, state: existing };
    }
    return { kind: "trustline_unauthorized", asset, state: existing };
  }

  // A very crude heuristic for "at limit". If available capacity is near zero.
  // We compare balance + buying_liabilities to limit. If it's equal, we are at limit.
  if (existing.balanceStroops + existing.buyingLiabilitiesStroops >= existing.limitStroops) {
    return { kind: "trustline_at_limit", asset, state: existing };
  }

  return { kind: "none" };
}
