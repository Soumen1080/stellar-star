/**
 * Locked FX quotes for expense entry (#323).
 *
 * The expense form separates four facts that used to be implicit:
 *
 *   1. **Entered currency & amount** — what the user typed (EUR 25.00). A
 *      display/provenance fact, never a payment denomination.
 *   2. **Quote** — the rate, its source and when it was fetched. The user sees
 *      it, can refresh it, and the one on screen is exactly the one saved.
 *   3. **Converted settlement amount** — `entered × rate`, computed with exact
 *      decimal arithmetic in the settlement asset's 7-decimal ledger precision.
 *   4. **Settlement asset** — the Stellar asset the debt is paid in (XLM).
 *
 * Conversion is allowed only from a `fresh` quote. Stale, expired, disputed or
 * unavailable quotes block it — the user must refresh, or switch the entry to
 * the settlement asset directly, which needs no quote at all.
 */

import {
  convertAssetAmount,
  formatAssetUnits,
  getAssetPrecision,
  normalizeDecimalRate,
  toLedgerAmount,
} from "@/lib/money/assetPrecision";
import { divideBigInt } from "@/lib/money/money";

/** Settlement asset for every expense created through the form today. */
export const SETTLEMENT_ASSET = "native";
export const SETTLEMENT_ASSET_CODE = "XLM";

/** How long a quote stays usable after it was fetched. */
export const QUOTE_LOCK_TTL_MS = 5 * 60_000;

/**
 * Two providers more than this far apart (basis points of the lower rate)
 * means at least one is wrong; neither number is safe to convert with.
 */
export const PROVIDER_DISAGREEMENT_BPS = 200;

export interface ProviderRate {
  source: string;
  rate: string;
}

/** A quote as shown to, and saved by, the user. */
export interface LockedQuote {
  /** Entered (display) currency, e.g. "EUR". */
  from: string;
  /** Settlement asset code — always XLM for now. */
  to: string;
  /** Exact decimal string: units of `to` per one unit of `from`. */
  rate: string;
  source: string;
  /** ISO time the provider produced the rate (saved as provenance). */
  fetchedAt: string;
  /**
   * ISO time this client locked the quote. Expiry counts from here: the
   * service's own `stale` flag already covers how old the provider rate is.
   */
  lockedAt: string;
  /** True when the service served a cached rate past its TTL. */
  stale: boolean;
  /** Spread between corroborating providers, when more than one answered. */
  spreadBps?: number;
  providers?: ProviderRate[];
}

export type QuoteState =
  | "native" // entered directly in the settlement asset: no quote needed
  | "loading"
  | "fresh"
  | "stale"
  | "expired"
  | "disagreement"
  | "unavailable";

export interface QuoteStateInput {
  currency: string;
  quote: LockedQuote | null;
  loading: boolean;
  /** True when the last fetch for this currency returned nothing usable. */
  failed: boolean;
  now?: number;
}

/** True when `currency` is the settlement asset itself. */
export function isSettlementCurrency(currency: string): boolean {
  const code = currency.trim().toUpperCase();
  return code === SETTLEMENT_ASSET_CODE || code === "NATIVE";
}

export function quoteAgeMs(quote: Pick<LockedQuote, "lockedAt">, now = Date.now()): number {
  const locked = Date.parse(quote.lockedAt);
  return Number.isFinite(locked) ? Math.max(0, now - locked) : Number.POSITIVE_INFINITY;
}

export function quoteState({ currency, quote, loading, failed, now = Date.now() }: QuoteStateInput): QuoteState {
  if (isSettlementCurrency(currency)) return "native";
  if (loading) return "loading";
  if (!quote || quote.from !== currency.toUpperCase()) return failed ? "unavailable" : "loading";
  if ((quote.spreadBps ?? 0) > PROVIDER_DISAGREEMENT_BPS) return "disagreement";
  if (quote.stale) return "stale";
  if (quoteAgeMs(quote, now) > QUOTE_LOCK_TTL_MS) return "expired";
  return "fresh";
}

/** Only a fresh quote may convert an amount. */
export function canConvertWith(state: QuoteState): boolean {
  return state === "fresh";
}

/** Whether the form can be submitted in this state. */
export function canSubmitWith(state: QuoteState): boolean {
  return state === "native" || state === "fresh";
}

export const QUOTE_STATE_MESSAGES: Record<QuoteState, string> = {
  native: "Entered directly in XLM — no conversion.",
  loading: "Fetching a quote…",
  fresh: "Quote locked. This exact rate is saved with the expense.",
  stale: "Only a cached rate is available. Refresh the quote, or enter the amount in XLM.",
  expired: "This quote has expired. Refresh it before saving, or enter the amount in XLM.",
  disagreement:
    "Price providers disagree on this rate. Refresh later, or enter the amount in XLM.",
  unavailable: "Exchange rates are unavailable right now. Enter the amount in XLM to continue.",
};

/**
 * Spread between the highest and lowest rate in basis points of the lowest,
 * computed exactly (no float division). Undefined with fewer than two rates.
 */
export function providerSpreadBps(rates: ProviderRate[]): number | undefined {
  const parsed = rates
    .map((r) => normalizeDecimalRate(r.rate))
    .filter((r): r is string => r !== null)
    .map(toScaled);
  if (parsed.length < 2) return undefined;
  const min = parsed.reduce((a, b) => (b < a ? b : a));
  const max = parsed.reduce((a, b) => (b > a ? b : a));
  if (min === 0n) return undefined;
  // ceil((max - min) * 10000 / min): round against the user, toward "disagree".
  const numerator = (max - min) * 10_000n;
  return Number((numerator + min - 1n) / min);
}

const RATE_SCALE_DECIMALS = 18;

function toScaled(rate: string): bigint {
  const [whole, fraction = ""] = rate.split(".");
  return BigInt(whole + fraction.padEnd(RATE_SCALE_DECIMALS, "0").slice(0, RATE_SCALE_DECIMALS));
}

/**
 * The settlement amount for `amount` entered in `currency`.
 *
 * - Settlement-asset input is never converted: it is only normalised to the
 *   7-decimal ledger form ("12.5" → "12.5000000").
 * - Fiat input converts through the locked quote, rounding half-even at the
 *   ledger precision.
 * - Returns null when the amount does not parse or conversion is not allowed.
 */
export function settlementAmountFor(
  amount: string,
  currency: string,
  quote: LockedQuote | null,
  state: QuoteState,
): string | null {
  const trimmed = amount.trim();
  if (!trimmed) return null;
  try {
    if (state === "native") return toLedgerAmount(trimmed, SETTLEMENT_ASSET_CODE);
    if (!quote || !canConvertWith(state)) return null;
    return convertAssetAmount(trimmed, currency, SETTLEMENT_ASSET_CODE, quote.rate);
  } catch {
    return null;
  }
}

/** Provenance recorded on the expense; immutable once saved. */
export interface FxProvenance {
  enteredCurrency: string;
  enteredAmount: string;
  settlementAsset: string;
  settlementAmount: string;
  exchangeRate?: string;
  exchangeRateSource?: string;
  exchangeRateTimestamp?: string;
}

export function buildProvenance(
  amount: string,
  currency: string,
  quote: LockedQuote | null,
  state: QuoteState,
): FxProvenance | null {
  const settlementAmount = settlementAmountFor(amount, currency, quote, state);
  if (settlementAmount === null) return null;
  const base = {
    enteredCurrency: currency.toUpperCase(),
    enteredAmount: amount.trim(),
    settlementAsset: SETTLEMENT_ASSET,
    settlementAmount,
  };
  if (state === "native" || !quote) return base;
  return {
    ...base,
    exchangeRate: quote.rate,
    exchangeRateSource: quote.source,
    exchangeRateTimestamp: quote.fetchedAt,
  };
}

/** One-line description of a saved expense's conversion, for its history. */
export function describeSavedConversion(expense: {
  currency: string;
  totalAmount: string;
  enteredAmount?: string;
  exchangeRate?: string;
  exchangeRateSource?: string;
  exchangeRateTimestamp?: string;
}): string {
  if (!expense.exchangeRate || isSettlementCurrency(expense.currency)) {
    return `Entered directly as ${expense.totalAmount} XLM (no conversion).`;
  }
  const amount = enteredAmountOf(expense);
  const entered = amount ? `${amount} ${expense.currency}` : expense.currency;
  const when = expense.exchangeRateTimestamp
    ? new Date(expense.exchangeRateTimestamp).toISOString().replace("T", " ").slice(0, 16) + " UTC"
    : "an unrecorded time";
  const source = expense.exchangeRateSource ?? "an unrecorded source";
  return `${entered} → ${expense.totalAmount} XLM at ${expense.exchangeRate} XLM/${expense.currency}, quoted by ${source} at ${when}.`;
}

/**
 * The amount as originally entered, for display. Uses the saved
 * `enteredAmount` when present; for older rows reconstructs it exactly as
 * `totalAmount / exchangeRate` with BigInt arithmetic, rounded half-even at the
 * currency's minor unit — never through floating point.
 */
export function enteredAmountOf(expense: {
  currency: string;
  totalAmount: string;
  enteredAmount?: string;
  exchangeRate?: string;
}): string | null {
  if (expense.enteredAmount) return expense.enteredAmount;
  if (!expense.exchangeRate || isSettlementCurrency(expense.currency)) return null;
  const rate = normalizeDecimalRate(expense.exchangeRate);
  const total = normalizeDecimalRate(expense.totalAmount);
  if (rate === null || total === null) return null;
  const decimals = getAssetPrecision(expense.currency).displayDecimals;
  const units = divideBigInt(toScaled(total) * 10n ** BigInt(decimals), toScaled(rate), "half_even");
  return formatAssetUnits(units, decimals);
}
