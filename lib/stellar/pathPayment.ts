/**
 * Path payments: settling a debt in an asset the payer does not hold.
 *
 * `pathPaymentStrictReceive` lets the sender spend XLM while the recipient
 * receives an exact USDC amount, atomically, through the Stellar DEX. "Strict
 * receive" is the half that matters for a debt: the *destination* amount is
 * fixed and the source amount floats. The alternative, strict-send, fixes what
 * you spend and lets the recipient receive whatever that buys — which for
 * settling a debt would mean underpaying whenever the book moves, so it is not
 * used here (invariant 1).
 *
 * ## Where naive implementations lose money
 *
 * The path Horizon returns is a *suggestion*, priced against an order book that
 * can move between the quote and the transaction landing. Two failure modes
 * follow, and this module is shaped around both:
 *
 * - `sendMax` set to exactly the quote: any adverse move fails the payment.
 * - `sendMax` set generously: the payer silently overpays into a thin book.
 *
 * The resolution is an explicit, bounded slippage tolerance that the user sees
 * before signing (invariant 3), and a hard freshness window after which a quote
 * must be re-fetched rather than used (invariant 2 — you cannot meaningfully
 * confirm a maximum derived from a stale book).
 */

import { Horizon } from "@stellar/stellar-sdk";
import {
  assetKey,
  CLASSIC_ASSET_DECIMALS,
  fromHorizonFields,
  isNative,
  type AssetRef,
} from "@/lib/stellar/assets";
import { HORIZON_URL } from "@/lib/utils/constants";

/** Classic Stellar assets are int64 stroops with exactly 7 decimals. */
const STROOPS_PER_UNIT = 10_000_000n;

/**
 * How long a quote may be used before it must be re-fetched.
 *
 * The DEX moves continuously, so any window is a judgement rather than a
 * guarantee. 30s is short enough that a book has usually not moved beyond the
 * slippage tolerance, and long enough for a user to read the confirmation and
 * approve a wallet prompt. Past it, `isQuoteFresh` returns false and the UI
 * re-quotes rather than signing against a stale number.
 */
export const QUOTE_FRESHNESS_MS = 30_000;

/** Slippage tolerances offered to the user, in basis points. */
export const SLIPPAGE_OPTIONS_BPS = [50, 100, 300] as const;

/**
 * Default slippage: 1%.
 *
 * Deliberately a *displayed* default, not a silent one — invariant 3. The
 * confirmation shows the resulting worst-case spend in the asset the payer
 * actually parts with, which is the number that matters to them.
 */
export const DEFAULT_SLIPPAGE_BPS = 100;

/** Upper bound on slippage the UI will accept. */
export const MAX_SLIPPAGE_BPS = 1_000;

/**
 * Price impact above which a path is flagged as dangerous.
 *
 * Not a hard rejection: a thin book is sometimes the only book, and refusing
 * outright would leave a payer unable to settle at all. It is surfaced as a
 * warning the user must see, so the choice to eat the impact is theirs and
 * informed rather than accidental.
 */
export const HIGH_PRICE_IMPACT_BPS = 500;

// ── Amount helpers ────────────────────────────────────────────────────────────

/** Parses a decimal Stellar amount into stroops. No floats. */
export function toStroops(amount: string): bigint {
  const trimmed = amount.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Not a valid Stellar amount: ${amount}`);
  }
  const [whole, fraction = ""] = trimmed.split(".");
  if (fraction.length > CLASSIC_ASSET_DECIMALS) {
    throw new Error(`Amount has more than ${CLASSIC_ASSET_DECIMALS} decimals: ${amount}`);
  }
  return BigInt(whole) * STROOPS_PER_UNIT + BigInt(fraction.padEnd(CLASSIC_ASSET_DECIMALS, "0"));
}

/** Renders stroops as a 7-decimal Stellar amount string. */
export function fromStroops(stroops: bigint): string {
  const negative = stroops < 0n;
  const abs = negative ? -stroops : stroops;
  const whole = abs / STROOPS_PER_UNIT;
  const fraction = (abs % STROOPS_PER_UNIT).toString().padStart(CLASSIC_ASSET_DECIMALS, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PathQuote {
  /** What the payer spends from. */
  sourceAsset: AssetRef;
  /** Horizon's estimate of the source amount required, as a decimal string. */
  sourceAmount: string;
  /** What the recipient receives. */
  destinationAsset: AssetRef;
  /** The exact amount the recipient receives. Fixed by construction. */
  destinationAmount: string;
  /** Intermediate hops. Empty for a direct order book. */
  path: AssetRef[];
  /** When this quote was fetched, epoch ms. */
  quotedAt: number;
  /**
   * Price impact against the best available rate, in basis points.
   *
   * Computed by comparing this path's rate to the best rate across all paths
   * Horizon returned. It is a relative measure: with one path there is nothing
   * to compare against and it is 0, which is honest rather than reassuring.
   */
  priceImpactBps: number;
}

export interface PricedPath extends PathQuote {
  /** Slippage tolerance applied, basis points. */
  slippageBps: number;
  /** The hard spend limit placed on the transaction, as a decimal string. */
  sendMax: string;
  /** True when the price impact exceeds `HIGH_PRICE_IMPACT_BPS`. */
  highPriceImpact: boolean;
}

/** Why path discovery produced nothing usable. */
export type PathFailureReason =
  /** Horizon answered, and no route exists between these assets. */
  | "no_path"
  /** Horizon could not be reached or errored. Retryable. */
  | "unavailable"
  /** The sender does not hold enough of anything to fund the receive amount. */
  | "insufficient_balance";

export class PathPaymentError extends Error {
  readonly reason: PathFailureReason;

  constructor(reason: PathFailureReason, message: string) {
    super(message);
    this.name = "PathPaymentError";
    this.reason = reason;
  }
}

// ── Freshness ─────────────────────────────────────────────────────────────────

/** True while a quote is young enough to sign against. */
export function isQuoteFresh(quote: PathQuote, now: number = Date.now()): boolean {
  return now - quote.quotedAt < QUOTE_FRESHNESS_MS;
}

/** Milliseconds until a quote goes stale; 0 once it has. */
export function quoteAgeRemainingMs(quote: PathQuote, now: number = Date.now()): number {
  return Math.max(0, QUOTE_FRESHNESS_MS - (now - quote.quotedAt));
}

// ── sendMax ───────────────────────────────────────────────────────────────────

/**
 * Derives the transaction's hard spend limit from a quote and a tolerance.
 *
 * `sendMax = sourceAmount * (1 + slippage)`, rounded **up** to the stroop. The
 * rounding direction matters: rounding down would build a limit fractionally
 * below the tolerance the user agreed to, and fail payments at the boundary.
 *
 * This is the number invariant 2 is about — the payer cannot spend more than
 * this, whatever the book does, because the network enforces it.
 */
export function deriveSendMax(sourceAmount: string, slippageBps: number): string {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps > MAX_SLIPPAGE_BPS) {
    throw new Error(
      `Slippage must be an integer between 0 and ${MAX_SLIPPAGE_BPS} basis points.`,
    );
  }

  const base = toStroops(sourceAmount);
  const numerator = base * BigInt(10_000 + slippageBps);
  // Ceiling division, so the limit is never a fraction below the agreed tolerance.
  const limit = (numerator + 9_999n) / 10_000n;

  return fromStroops(limit);
}

/** Applies a slippage tolerance to a quote, producing a signable path. */
export function priceQuote(quote: PathQuote, slippageBps: number): PricedPath {
  return {
    ...quote,
    slippageBps,
    sendMax: deriveSendMax(quote.sourceAmount, slippageBps),
    highPriceImpact: quote.priceImpactBps >= HIGH_PRICE_IMPACT_BPS,
  };
}

// ── Discovery ─────────────────────────────────────────────────────────────────

interface HorizonPathRecord {
  source_asset_type?: string;
  source_asset_code?: string;
  source_asset_issuer?: string;
  source_amount?: string;
  destination_asset_type?: string;
  destination_asset_code?: string;
  destination_asset_issuer?: string;
  destination_amount?: string;
  path?: Array<{
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
  }>;
}

/**
 * Computes each path's price impact relative to the cheapest path found.
 *
 * Horizon does not report price impact, so this is derived: the best path is
 * the benchmark, and every other path's excess source amount over it is the
 * impact. With a single path there is no benchmark and the impact reads 0 —
 * which is why `highPriceImpact` is a warning about the *chosen* route rather
 * than a claim that a lone route is cheap.
 */
function withPriceImpact(records: PathQuote[]): PathQuote[] {
  if (records.length === 0) return records;

  const best = records.reduce((lowest, candidate) =>
    toStroops(candidate.sourceAmount) < toStroops(lowest.sourceAmount) ? candidate : lowest,
  );
  const bestStroops = toStroops(best.sourceAmount);
  if (bestStroops === 0n) return records;

  return records.map((record) => {
    const excess = toStroops(record.sourceAmount) - bestStroops;
    const impactBps = Number((excess * 10_000n) / bestStroops);
    return { ...record, priceImpactBps: impactBps };
  });
}

export interface FindPathsParams {
  sourceAccount: string;
  destinationAsset: AssetRef;
  /** The exact amount the recipient must receive. */
  destinationAmount: string;
  /** Restrict to a specific source asset. Omit to consider everything held. */
  sourceAsset?: AssetRef;
  horizonUrl?: string;
  /** Injectable for tests against recorded fixtures. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Finds routes that deliver exactly `destinationAmount` of the destination
 * asset, paid for out of what `sourceAccount` actually holds.
 *
 * Uses Horizon's `strict-receive` path endpoint, which is the one that matches
 * the invariant: the destination amount is the input, and the source amounts
 * come back as answers.
 *
 * Returns quotes sorted cheapest-first. Throws `PathPaymentError` with a
 * `reason` the UI can act on rather than a generic failure (invariant 5).
 */
export async function findPaymentPaths({
  sourceAccount,
  destinationAsset,
  destinationAmount,
  sourceAsset,
  horizonUrl = HORIZON_URL,
  fetchImpl = fetch,
  now = Date.now,
}: FindPathsParams): Promise<PathQuote[]> {
  const params = new URLSearchParams({
    destination_asset_type: isNative(destinationAsset) ? "native" : assetTypeFor(destinationAsset),
    destination_amount: destinationAmount,
  });

  if (!isNative(destinationAsset)) {
    params.set("destination_asset_code", destinationAsset.code);
    params.set("destination_asset_issuer", destinationAsset.issuer as string);
  }

  if (sourceAsset) {
    // Restricting the source narrows the search to one asset the payer holds.
    params.set("source_assets", assetKey(sourceAsset) === "native" ? "native" : `${sourceAsset.code}:${sourceAsset.issuer}`);
  } else {
    params.set("source_account", sourceAccount);
  }

  let response: Response;
  try {
    response = await fetchImpl(`${horizonUrl}/paths/strict-receive?${params.toString()}`, {
      cache: "no-store",
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new PathPaymentError("unavailable", `Could not reach Horizon to find a path: ${message}`);
  }

  if (!response.ok) {
    throw new PathPaymentError(
      "unavailable",
      `Horizon returned HTTP ${response.status} while searching for a payment path.`,
    );
  }

  const body = (await response.json()) as { _embedded?: { records?: HorizonPathRecord[] } };
  const records = body._embedded?.records ?? [];

  if (records.length === 0) {
    throw new PathPaymentError(
      "no_path",
      "No conversion route exists between the assets you hold and the asset this debt is denominated in.",
    );
  }

  const quotedAt = now();
  const quotes: PathQuote[] = records
    .filter((record) => record.source_amount && record.destination_amount)
    .map((record) => ({
      sourceAsset: fromHorizonFields(
        record.source_asset_type,
        record.source_asset_code,
        record.source_asset_issuer,
      ),
      sourceAmount: record.source_amount as string,
      destinationAsset: fromHorizonFields(
        record.destination_asset_type,
        record.destination_asset_code,
        record.destination_asset_issuer,
      ),
      destinationAmount: record.destination_amount as string,
      path: (record.path ?? []).map((hop) =>
        fromHorizonFields(hop.asset_type, hop.asset_code, hop.asset_issuer),
      ),
      quotedAt,
      priceImpactBps: 0,
    }));

  if (quotes.length === 0) {
    throw new PathPaymentError("no_path", "Horizon returned no usable payment path.");
  }

  return withPriceImpact(quotes).sort((a, b) =>
    toStroops(a.sourceAmount) < toStroops(b.sourceAmount) ? -1 : 1,
  );
}

function assetTypeFor(ref: AssetRef): string {
  if (isNative(ref)) return "native";
  return ref.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12";
}

/**
 * Finds the cheapest route and prices it at the given tolerance.
 *
 * The convenience wrapper the UI actually calls.
 */
export async function quoteBestPath(
  params: FindPathsParams,
  slippageBps: number = DEFAULT_SLIPPAGE_BPS,
): Promise<PricedPath> {
  const quotes = await findPaymentPaths(params);
  return priceQuote(quotes[0], slippageBps);
}

// ── Trustline check ───────────────────────────────────────────────────────────

/**
 * Whether `account` can receive `asset`.
 *
 * Path payments do not avoid the trustline requirement, they compose with it:
 * the recipient must already trust the destination asset or the payment fails
 * on submission. Checking first turns that into an explainable pre-condition
 * rather than an opaque `op_no_trust` after the user has signed.
 */
export async function hasTrustline(
  account: string,
  asset: AssetRef,
  horizonUrl: string = HORIZON_URL,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  if (isNative(asset)) return true;

  let response: Response;
  try {
    response = await fetchImpl(`${horizonUrl}/accounts/${account}`, { cache: "no-store" });
  } catch {
    throw new PathPaymentError("unavailable", "Could not reach Horizon to check the trustline.");
  }

  if (!response.ok) {
    throw new PathPaymentError(
      "unavailable",
      `Horizon returned HTTP ${response.status} while checking the trustline.`,
    );
  }

  const account_ = (await response.json()) as {
    balances?: Array<{ asset_type?: string; asset_code?: string; asset_issuer?: string }>;
  };

  return (account_.balances ?? []).some((balance) => {
    if (balance.asset_type === "native") return false;
    return balance.asset_code === asset.code && balance.asset_issuer === asset.issuer;
  });
}

/** Re-exported so callers building operations do not need a second import. */
export type { Horizon };
