"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, Link2, QrCode, RefreshCw, ShieldCheck, TimerOff, X } from "lucide-react";
import {
  buildPayURI,
  buildTxURI,
  createPaymentRequest,
  describePaymentRequest,
  paymentRequestLink,
  PaymentRequestError,
  DEFAULT_REQUEST_TTL_SECONDS,
  type CreatePaymentRequestInput,
  type PaymentRequest,
} from "@/lib/qr/paymentRequest";
import { getSuggestedBaseFee } from "@/lib/stellar/fees";
import { HORIZON_URL, STELLAR_NETWORK } from "@/lib/utils/constants";
import { cn, copyToClipboard } from "@/lib/utils";
import { useToast } from "@/components/ui/Toast";

export type PaymentRequestInput = Omit<CreatePaymentRequestInput, "network" | "nowSeconds" | "ttlSeconds">;

const TTL_OPTIONS: Array<[number, string]> = [
  [60 * 60, "1 hour"],
  [DEFAULT_REQUEST_TTL_SECONDS, "24 hours"],
  [7 * 24 * 60 * 60, "7 days"],
];

/** Current sequence of the payer's account, or null when it cannot be read. */
async function loadSequence(account: string): Promise<string | null> {
  try {
    const res = await fetch(`${HORIZON_URL}/accounts/${account}`, { cache: "no-store" });
    if (!res.ok) return null;
    const body = (await res.json()) as { sequence?: string };
    return typeof body.sequence === "string" ? body.sequence : null;
  } catch {
    return null;
  }
}

/**
 * A payment request for an outstanding share or net settlement (#327): a
 * human-readable preview, a QR, an expiry, and copyable fallbacks.
 */
export function PaymentRequestPanel({ input, className }: { input: PaymentRequestInput; className?: string }) {
  const { error: toastError } = useToast();
  const [ttl, setTtl] = useState(DEFAULT_REQUEST_TTL_SECONDS);
  const [nonce, setNonce] = useState(0);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const [txUri, setTxUri] = useState<string | null>(null);
  const [copied, setCopied] = useState<"uri" | "link" | null>(null);

  const built = useMemo((): { request: PaymentRequest } | { error: string } => {
    try {
      return {
        request: createPaymentRequest({
          ...input,
          network: STELLAR_NETWORK,
          ttlSeconds: ttl,
          nowSeconds: Math.floor(Date.now() / 1000),
        }),
      };
    } catch (err) {
      return { error: err instanceof PaymentRequestError ? err.message : "This request cannot be created." };
    }
    // `nonce` regenerates with a fresh expiry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input.kind, input.destination, input.source, input.asset, input.amount, input.tripId, JSON.stringify(input.items), ttl, nonce]);

  const request = "request" in built ? built.request : null;

  // Prefer a time-bounded `tx` QR when the payer's account can be read.
  useEffect(() => {
    let cancelled = false;
    setTxUri(null);
    if (!request?.source) return;
    void (async () => {
      const [sequence, fee] = await Promise.all([loadSequence(request.source!), getSuggestedBaseFee().catch(() => "100")]);
      if (cancelled || !sequence) return;
      try {
        setTxUri(buildTxURI(request, sequence, fee));
      } catch {
        setTxUri(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  const copy = useCallback(
    async (what: "uri" | "link", value: string) => {
      if (await copyToClipboard(value)) {
        setCopied(what);
        setTimeout(() => setCopied(null), 2000);
      } else {
        toastError("Copy unavailable", "Your browser doesn't support clipboard access. Please copy it manually.");
      }
    },
    [toastError],
  );

  if (!request) {
    return (
      <p className={cn("text-xs text-orange-600", className)} role="alert">
        {"error" in built ? built.error : "This request cannot be created."}
      </p>
    );
  }

  const preview = describePaymentRequest(request, now);
  const payUri = buildPayURI(request);
  const appLink = typeof window !== "undefined" ? paymentRequestLink(window.location.origin, request) : "";
  const qrValue = txUri ?? payUri;

  return (
    <div className={cn("flex flex-col gap-3 rounded-2xl border border-[#E5E5E5] bg-white p-4", className)}>
      <div className="flex flex-col items-center gap-2">
        <div className={cn("relative rounded-xl border border-[#F0F0F0] bg-white p-3 shadow-sm", preview.expired && "opacity-20")}>
          <QRCodeSVG value={qrValue} size={168} bgColor="#ffffff" fgColor="#0F0F14" level="M" includeMargin={false} />
        </div>
        {preview.expired ? (
          <p className="flex items-center gap-1 text-xs font-semibold text-red-600" role="alert">
            <TimerOff size={12} /> Expired — generate a new request.
          </p>
        ) : (
          <p className="flex items-center gap-1 text-[10px] text-[#888]">
            <ShieldCheck size={11} className="text-[#2DD4BF]" />
            {txUri
              ? "Transaction QR: refused by the network after expiry, on another network, or once paid."
              : "Payment QR for SEP-0007 wallets (Freighter, Lobstr, …)."}
          </p>
        )}
      </div>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1 text-[11px]" aria-label="Payment request preview">
        {preview.lines.map((line) => (
          <div key={line.label} className="contents">
            <dt className="text-[#888]">{line.label}</dt>
            <dd className="break-all font-medium text-[#0F0F14]">{line.value}</dd>
          </div>
        ))}
      </dl>

      <div className="flex flex-wrap items-center gap-3 text-xs font-semibold">
        <button
          type="button"
          disabled={preview.expired}
          onClick={() => copy("uri", payUri)}
          className="inline-flex items-center gap-1 text-[#555] hover:text-[#0F0F14] disabled:opacity-40"
        >
          {copied === "uri" ? <Check size={12} className="text-[#134E4A]" /> : <Copy size={12} />}
          {copied === "uri" ? "Copied!" : "Copy wallet URI"}
        </button>
        <button
          type="button"
          disabled={preview.expired || !appLink}
          onClick={() => copy("link", appLink)}
          className="inline-flex items-center gap-1 text-[#555] hover:text-[#0F0F14] disabled:opacity-40"
        >
          {copied === "link" ? <Check size={12} className="text-[#134E4A]" /> : <Link2 size={12} />}
          {copied === "link" ? "Copied!" : "Copy app link"}
        </button>
        <label className="sr-only" htmlFor={`request-ttl-${request.reference}`}>
          Expires after
        </label>
        <select
          id={`request-ttl-${request.reference}`}
          value={ttl}
          onChange={(e) => setTtl(Number(e.target.value))}
          className="rounded-lg border border-[#E5E5E5] px-1.5 py-0.5 font-normal"
        >
          {TTL_OPTIONS.map(([seconds, label]) => (
            <option key={seconds} value={seconds}>
              Expires in {label}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => setNonce((n) => n + 1)}
          className="inline-flex items-center gap-1 text-[#555] hover:text-[#0F0F14]"
        >
          <RefreshCw size={12} /> New request
        </button>
      </div>
    </div>
  );
}

/** Trigger + inline panel, like `QRToggle`. */
export function PaymentRequestToggle({ input, label = "Request QR" }: { input: PaymentRequestInput; label?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#888] transition-colors hover:text-[#0F0F14]"
        aria-expanded={open}
      >
        {open ? <X size={12} /> : <QrCode size={12} />}
        {open ? "Hide request" : label}
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="mt-2 overflow-hidden"
          >
            <PaymentRequestPanel input={input} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
