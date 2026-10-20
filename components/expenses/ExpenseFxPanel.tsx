"use client";

import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";
import { describeAge } from "@/lib/fx/quote";
import {
  QUOTE_STATE_MESSAGES,
  SETTLEMENT_ASSET_CODE,
  quoteAgeMs,
  type LockedQuote,
  type QuoteState,
} from "@/lib/fx/quoteLock";
import { cn } from "@/lib/utils";

interface ExpenseFxPanelProps {
  enteredAmount: string;
  currency: string;
  quote: LockedQuote | null;
  state: QuoteState;
  settlementAmount: string | null;
  error?: string;
  onRefresh: () => void;
  onUseSettlementAsset: () => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <dt className="text-[11px] uppercase tracking-wide text-[#999]">{label}</dt>
      <dd className="text-right text-xs font-semibold text-[#0F0F14] break-all">{children}</dd>
    </div>
  );
}

/**
 * Makes the four facts of a multi-currency expense explicit: what was typed,
 * the quote (rate, source, time), the converted amount, and the Stellar asset
 * it settles in. The quote shown is exactly the one that will be saved.
 */
export function ExpenseFxPanel({
  enteredAmount,
  currency,
  quote,
  state,
  settlementAmount,
  error,
  onRefresh,
  onUseSettlementAsset,
}: ExpenseFxPanelProps) {
  const native = state === "native";
  const blocked = !native && state !== "fresh" && state !== "loading";
  const message = error ?? QUOTE_STATE_MESSAGES[state];

  return (
    <section
      aria-label="Currency conversion"
      className={cn(
        "rounded-xl border p-3",
        blocked ? "border-amber-200 bg-amber-50" : "border-[#EFEFEF] bg-[#FAFAFA]",
      )}
    >
      <dl>
        <Row label="Entered">
          {enteredAmount.trim() || "—"} {currency}
        </Row>
        {!native && (
          <Row label="Quote">
            {quote ? (
              <>
                1 {quote.from} = {quote.rate} {SETTLEMENT_ASSET_CODE}
                <span className="block font-normal text-[#888]">
                  {quote.source} · fetched {new Date(quote.fetchedAt).toISOString().slice(11, 16)} UTC
                  {" · "}locked {describeAge(quoteAgeMs(quote))} ago
                  {quote.spreadBps !== undefined && ` · providers within ${(quote.spreadBps / 100).toFixed(2)}%`}
                </span>
              </>
            ) : state === "loading" ? (
              "Fetching…"
            ) : (
              "None"
            )}
          </Row>
        )}
        <Row label="Settles as">
          {settlementAmount ?? "—"} {SETTLEMENT_ASSET_CODE}
        </Row>
        <Row label="Settlement asset">Stellar native asset ({SETTLEMENT_ASSET_CODE})</Row>
      </dl>

      <p
        role={blocked ? "alert" : undefined}
        className={cn(
          "mt-2 flex items-start gap-1.5 text-[11px]",
          blocked ? "text-amber-800" : "text-[#0F766E]",
        )}
      >
        {blocked ? <AlertTriangle size={12} className="mt-0.5 shrink-0" /> : <CheckCircle2 size={12} className="mt-0.5 shrink-0" />}
        {message}
      </p>

      {!native && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            onClick={onRefresh}
            disabled={state === "loading"}
            className="inline-flex items-center gap-1 rounded-lg border border-[#E5E5E5] bg-white px-2.5 py-1.5 text-[11px] font-bold text-[#0F0F14] hover:bg-[#F0F0F0] disabled:opacity-50"
          >
            <RefreshCw size={11} className={state === "loading" ? "animate-spin" : undefined} />
            Refresh quote
          </button>
          {blocked && (
            <button
              type="button"
              onClick={onUseSettlementAsset}
              className="rounded-lg px-2.5 py-1.5 text-[11px] font-bold text-[#134E4A] hover:underline"
            >
              Enter in {SETTLEMENT_ASSET_CODE} instead
            </button>
          )}
        </div>
      )}
    </section>
  );
}
