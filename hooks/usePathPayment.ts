"use client";

/**
 * Quote lifecycle for a path payment.
 *
 * Owns the parts of invariants 2, 3 and 5 that are stateful: fetching a route,
 * re-pricing it when the user changes their slippage tolerance, and keeping it
 * fresh.
 *
 * ## Quote refresh strategy
 *
 * Quotes are refreshed on demand, not on a timer. An auto-refreshing quote
 * changes the confirmed maximum out from under someone mid-read, which is
 * precisely the thing invariant 2 forbids — the number they agreed to must be
 * the number enforced. Instead the quote visibly expires, signing is blocked
 * while it is stale, and refreshing is a deliberate act.
 *
 * Changing slippage re-prices the *existing* quote rather than re-fetching. The
 * order book has not changed because the user moved a control, so a refetch
 * would be a pointless round trip and would reset the freshness window on a
 * quote that was already valid.
 */

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_SLIPPAGE_BPS,
  findPaymentPaths,
  hasTrustline,
  PathPaymentError,
  priceQuote,
  type PathFailureReason,
  type PathQuote,
  type PricedPath,
} from "@/lib/stellar/pathPayment";
import { NATIVE_ASSET, formatAssetLabel, type AssetRef } from "@/lib/stellar/assets";

export interface UsePathPaymentParams {
  sourceAccount: string | null;
  destinationAccount: string | null;
  /** The asset the debt is denominated in. */
  destinationAsset: AssetRef;
  /** Exact amount owed. */
  destinationAmount: string;
  /** Restrict spending to one asset the payer holds. */
  sourceAsset?: AssetRef;
}

export interface PathFailure {
  reason: PathFailureReason;
  message: string;
}

export function usePathPayment({
  sourceAccount,
  destinationAccount,
  destinationAsset,
  destinationAmount,
  sourceAsset,
}: UsePathPaymentParams) {
  const [quote, setQuote] = useState<PathQuote | null>(null);
  const [slippageBps, setSlippageBps] = useState(DEFAULT_SLIPPAGE_BPS);
  const [loading, setLoading] = useState(false);
  const [failure, setFailure] = useState<PathFailure | null>(null);

  const refreshQuote = useCallback(async () => {
    if (!sourceAccount || !destinationAccount) return;

    setLoading(true);
    setFailure(null);
    setQuote(null);

    try {
      // The recipient must be able to hold the destination asset. Path payments
      // compose with the trustline requirement rather than avoiding it, and
      // finding out after signing means an opaque `op_no_trust` failure.
      const trusted = await hasTrustline(destinationAccount, destinationAsset);
      if (!trusted) {
        setFailure({
          reason: "no_path",
          message:
            `The recipient cannot receive ${formatAssetLabel(destinationAsset)} — they have ` +
            `no trustline for it. Ask them to add one, then try again.`,
        });
        return;
      }

      const quotes = await findPaymentPaths({
        sourceAccount,
        destinationAsset,
        destinationAmount,
        sourceAsset,
      });

      setQuote(quotes[0]);
    } catch (err) {
      if (err instanceof PathPaymentError) {
        setFailure({ reason: err.reason, message: err.message });
      } else {
        setFailure({
          reason: "unavailable",
          message: err instanceof Error ? err.message : "Could not price a route.",
        });
      }
    } finally {
      setLoading(false);
    }
  }, [sourceAccount, destinationAccount, destinationAsset, destinationAmount, sourceAsset]);

  // Re-price locally when the tolerance changes — the book has not moved
  // because the user clicked a button.
  const pricedPath: PricedPath | null = quote ? priceQuote(quote, slippageBps) : null;

  return {
    /** The priced route, or null while loading or on failure. */
    path: pricedPath,
    loading,
    failure,
    slippageBps,
    setSlippageBps,
    refreshQuote,
    /** Discards the current quote, e.g. when the dialog closes. */
    clear: useCallback(() => {
      setQuote(null);
      setFailure(null);
    }, []),
  };
}

/**
 * Whether a debt needs a path payment at all.
 *
 * A payer who already holds the denominated asset should take the direct
 * `payment` route: it is cheaper, has no slippage, and needs no confirmation
 * dialog. Path payments are for the case the issue names — settling in an asset
 * you do not hold.
 */
export function useNeedsConversion(
  heldAssets: AssetRef[],
  destinationAsset: AssetRef = NATIVE_ASSET,
): boolean {
  const [needs, setNeeds] = useState(false);

  useEffect(() => {
    const key = (a: AssetRef) => (a.issuer ? `${a.code}:${a.issuer}` : "native");
    setNeeds(!heldAssets.some((a) => key(a) === key(destinationAsset)));
  }, [heldAssets, destinationAsset]);

  return needs;
}
