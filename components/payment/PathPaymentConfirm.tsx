"use client";

/**
 * Pre-signature confirmation for a path payment.
 *
 * This component is where invariants 2, 3 and 5 are actually satisfied for the
 * user. Everything below is on screen *before* the wallet prompt:
 *
 *   - the exact amount the recipient receives (fixed by strict-receive)
 *   - the worst-case amount the payer can spend, and in which asset
 *   - the slippage tolerance producing that worst case, as a control rather
 *     than a silent default
 *   - price impact, flagged when the route is thin
 *   - how long the quote remains valid, counting down
 *
 * A quote that goes stale disables signing rather than quietly proceeding: a
 * confirmed maximum derived from a book that has since moved is not a confirmed
 * maximum.
 */

import React, { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Clock, Info, RefreshCw } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { formatAssetLabel } from "@/lib/stellar/assets";
import {
  isQuoteFresh,
  quoteAgeRemainingMs,
  MAX_SLIPPAGE_BPS,
  SLIPPAGE_OPTIONS_BPS,
  type PathFailureReason,
  type PricedPath,
} from "@/lib/stellar/pathPayment";

interface PathPaymentConfirmProps {
  open: boolean;
  onClose: () => void;
  recipientName: string;
  /** The priced route, or null while quoting. */
  path: PricedPath | null;
  loading: boolean;
  /** Why no route was found, if discovery failed. */
  failure: { reason: PathFailureReason; message: string } | null;
  slippageBps: number;
  onSlippageChange: (bps: number) => void;
  onRefreshQuote: () => void;
  onConfirm: () => void;
}

function bpsToPercent(bps: number): string {
  return `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;
}

/** Human guidance per failure reason — invariant 5. */
function failureGuidance(reason: PathFailureReason): string {
  switch (reason) {
    case "no_path":
      return (
        "No route exists on the Stellar DEX between the assets you hold and the asset " +
        "this debt is in. You can acquire that asset directly, or ask to settle in " +
        "another one."
      );
    case "insufficient_balance":
      return (
        "You hold the right assets, but not enough of them to cover this amount at the " +
        "current rate. Add funds and try again."
      );
    case "unavailable":
      return "Could not reach the Stellar network to price a route. This is usually temporary — try again shortly.";
  }
}

export function PathPaymentConfirm({
  open,
  onClose,
  recipientName,
  path,
  loading,
  failure,
  slippageBps,
  onSlippageChange,
  onRefreshQuote,
  onConfirm,
}: PathPaymentConfirmProps) {
  // Drives the countdown; the freshness decision itself is `isQuoteFresh`.
  const [, forceTick] = useState(0);

  useEffect(() => {
    if (!open || !path) return;
    const id = setInterval(() => forceTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [open, path]);

  const fresh = path ? isQuoteFresh(path) : false;
  const secondsLeft = path ? Math.ceil(quoteAgeRemainingMs(path) / 1000) : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Confirm conversion"
      description={`Settle with ${recipientName} using an asset you already hold.`}
      size="md"
    >
      {loading && (
        <div className="flex items-center gap-3 py-8 justify-center text-sm text-white/60">
          <Spinner />
          Finding the best route…
        </div>
      )}

      {!loading && failure && (
        <div className="space-y-4">
          <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-4">
            <AlertTriangle size={18} className="shrink-0 text-amber-400 mt-0.5" />
            <div className="space-y-1">
              <p className="text-sm font-semibold text-amber-200">No route available</p>
              <p className="text-sm text-amber-100/80">{failure.message}</p>
              <p className="text-sm text-amber-100/60">{failureGuidance(failure.reason)}</p>
            </div>
          </div>
          <div className="flex gap-2 justify-end">
            <Button variant="ghost-white" onClick={onClose}>
              Close
            </Button>
            {failure.reason === "unavailable" && (
              <Button onClick={onRefreshQuote}>Try again</Button>
            )}
          </div>
        </div>
      )}

      {!loading && !failure && path && (
        <div className="space-y-5">
          {/* What moves. The received amount is exact by construction. */}
          <div className="rounded-xl border border-white/10 bg-white/[0.02] p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-xs uppercase tracking-wide text-white/40">You send up to</p>
                <p className="text-lg font-bold text-white">
                  {path.sendMax} {formatAssetLabel(path.sourceAsset)}
                </p>
              </div>
              <ArrowRight size={18} className="shrink-0 text-white/30" />
              <div className="text-right">
                <p className="text-xs uppercase tracking-wide text-white/40">
                  {recipientName} receives
                </p>
                <p className="text-lg font-bold text-[#2DD4BF]">
                  {path.destinationAmount} {formatAssetLabel(path.destinationAsset)}
                </p>
              </div>
            </div>
          </div>

          <dl className="space-y-2 text-sm">
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Expected to spend</dt>
              <dd className="text-white/80">
                {path.sourceAmount} {formatAssetLabel(path.sourceAsset)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="font-medium text-white/70">Maximum you can spend</dt>
              {/* Invariant 2: this is the network-enforced ceiling. */}
              <dd className="font-semibold text-white">
                {path.sendMax} {formatAssetLabel(path.sourceAsset)}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Route</dt>
              <dd className="text-white/80">
                {path.path.length === 0
                  ? "Direct"
                  : [path.sourceAsset, ...path.path, path.destinationAsset]
                      .map((a) => formatAssetLabel(a))
                      .join(" → ")}
              </dd>
            </div>
            <div className="flex justify-between gap-4">
              <dt className="text-white/50">Price impact</dt>
              <dd className={path.highPriceImpact ? "text-amber-300" : "text-white/80"}>
                {bpsToPercent(path.priceImpactBps)}
              </dd>
            </div>
          </dl>

          {/* Invariant 3: tolerance is explicit and adjustable, never silent. */}
          <div className="space-y-2">
            <div className="flex items-center gap-1.5">
              <p className="text-xs uppercase tracking-wide text-white/40">
                Slippage tolerance
              </p>
              <span title="How far the exchange rate may move against you before the payment fails. A higher tolerance is more likely to succeed but raises your maximum spend.">
                <Info size={12} className="text-white/30" />
              </span>
            </div>
            <div className="flex gap-2">
              {SLIPPAGE_OPTIONS_BPS.map((bps) => (
                <button
                  key={bps}
                  type="button"
                  onClick={() => onSlippageChange(bps)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium transition-colors ${
                    slippageBps === bps
                      ? "bg-[#2DD4BF] text-[#0F0F14]"
                      : "bg-white/5 text-white/70 hover:bg-white/10"
                  }`}
                >
                  {bpsToPercent(bps)}
                </button>
              ))}
            </div>
            <p className="text-xs text-white/40">
              Raising this raises your maximum spend, shown above. Capped at{" "}
              {bpsToPercent(MAX_SLIPPAGE_BPS)}.
            </p>
          </div>

          {path.highPriceImpact && (
            <div className="flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 p-3">
              <AlertTriangle size={16} className="shrink-0 text-amber-400 mt-0.5" />
              <p className="text-sm text-amber-100/90">
                This route has a price impact of {bpsToPercent(path.priceImpactBps)}. The
                order book for this pair is thin, so you are paying noticeably above the
                best available rate. Consider settling a smaller amount, or in a different
                asset.
              </p>
            </div>
          )}

          {/* Freshness: a stale quote cannot be signed against. */}
          <div
            className={`flex items-center justify-between gap-3 rounded-xl border p-3 ${
              fresh
                ? "border-white/10 bg-white/[0.02]"
                : "border-amber-500/30 bg-amber-500/10"
            }`}
          >
            <div className="flex items-center gap-2 text-sm">
              <Clock size={14} className={fresh ? "text-white/40" : "text-amber-400"} />
              <span className={fresh ? "text-white/60" : "text-amber-100"}>
                {fresh
                  ? `Quote valid for ${secondsLeft}s`
                  : "Quote expired — the rate may have moved"}
              </span>
            </div>
            <button
              type="button"
              onClick={onRefreshQuote}
              className="inline-flex items-center gap-1.5 text-sm font-medium text-[#2DD4BF] hover:underline"
            >
              <RefreshCw size={13} />
              Refresh
            </button>
          </div>

          <div className="flex gap-2 justify-end pt-1">
            <Button variant="ghost-white" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={onConfirm} disabled={!fresh}>
              {fresh ? `Confirm — spend up to ${path.sendMax}` : "Refresh quote to continue"}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
