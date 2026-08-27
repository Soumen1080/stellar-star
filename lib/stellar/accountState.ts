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

/** Stellar's base reserve, in stroops. 0.5 XLM at protocol 19+. */
export const BASE_RESERVE_STROOPS = 5_000_000n;

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
  /** Balance above the reserve — what can actually be spent. */
  spendableStroops: bigint;
  /** Number of subentries (trustlines, offers, signers). */
  subentryCount: number;
  /** Assets this account can receive, beyond native. */
  trustlines: AssetRef[];
  /** True when the account's reserves are paid by a sponsor. */
  sponsored: boolean;
  /** The sponsor's address, when sponsored. */
  sponsorId: string | null;
}

/** Minimum balance for an account with `subentries` subentries, in stroops. */
export function minimumBalanceStroops(subentries: number): bigint {
  return (BASE_ACCOUNT_SUBENTRIES + BigInt(subentries)) * BASE_RESERVE_STROOPS;
}

/**
 * Additional reserve a new trustline would require.
 *
 * The number that makes an empty wallet unable to receive USDC: it is not
 * enough to have an account, you need half a lumen more for each asset you
 * want to hold.
 */
export function trustlineReserveStroops(): bigint {
  return BASE_RESERVE_STROOPS;
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

  if (response.status === 404) {
    return {
      publicKey,
      status: "unfunded",
      balanceStroops: 0n,
      reserveStroops: minimumBalanceStroops(0),
      spendableStroops: 0n,
      subentryCount: 0,
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

  const subentryCount = account.subentry_count ?? 0;
  const reserveStroops = minimumBalanceStroops(subentryCount);
  const spendableStroops =
    balanceStroops > reserveStroops ? balanceStroops - reserveStroops : 0n;

  const trustlines = balances
    .filter((b) => b.asset_type && b.asset_type !== "native")
    .map((b) => fromHorizonFields(b.asset_type, b.asset_code, b.asset_issuer));

  return {
    publicKey,
    status: spendableStroops > 0n ? "funded" : "reserve_locked",
    balanceStroops,
    reserveStroops,
    spendableStroops,
    subentryCount,
    trustlines,
    sponsored: Boolean(account.sponsor) || (account.num_sponsored ?? 0) > 0,
    sponsorId: account.sponsor ?? null,
  };
}

/** True when the account can receive `asset` today. */
export function canReceive(state: AccountState, asset: AssetRef): boolean {
  if (state.status === "unfunded") return false;
  if (isNative(asset)) return true;
  return state.trustlines.some((line) => assetKey(line) === assetKey(asset));
}

/** What stands between this account and receiving `asset`. */
export type OnboardingNeed =
  | { kind: "none" }
  /** The account does not exist and must be created. */
  | { kind: "account_creation"; reserveStroops: bigint }
  /** The account exists but needs a trustline it cannot afford. */
  | { kind: "trustline"; asset: AssetRef; reserveStroops: bigint; affordable: boolean };

export function describeOnboardingNeed(
  state: AccountState,
  asset: AssetRef,
): OnboardingNeed {
  if (state.status === "unfunded") {
    // A bare account plus one trustline, so the created account can actually
    // hold the asset rather than needing a second top-up immediately.
    const needed = isNative(asset)
      ? minimumBalanceStroops(0)
      : minimumBalanceStroops(1);
    return { kind: "account_creation", reserveStroops: needed };
  }

  if (isNative(asset) || canReceive(state, asset)) {
    return { kind: "none" };
  }

  const needed = trustlineReserveStroops();
  return {
    kind: "trustline",
    asset,
    reserveStroops: needed,
    affordable: state.spendableStroops >= needed,
  };
}
