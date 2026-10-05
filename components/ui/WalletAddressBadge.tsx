"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn, copyToClipboard, formatAddress } from "@/lib/utils";

export interface WalletAddressBadgeProps {
  address: string;
  truncateLength?: number;
  copyable?: boolean;
  className?: string;
}

export function WalletAddressBadge({
  address,
  truncateLength = 4,
  copyable = true,
  className,
}: WalletAddressBadgeProps) {
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const shouldTruncate = address.length > truncateLength * 2 + 3;
  const displayAddress = shouldTruncate
    ? formatAddress(address, truncateLength)
    : address;

  useEffect(
    () => () => {
      if (resetTimer.current) clearTimeout(resetTimer.current);
    },
    [],
  );

  const handleCopy = async () => {
    if (!(await copyToClipboard(address))) return;

    setCopied(true);
    if (resetTimer.current) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => setCopied(false), 2_000);
  };

  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1 rounded-md bg-[#F6F6F6] px-1.5 py-0.5 text-[11px] text-[#666]",
        className,
      )}
      title={address}
    >
      <span className="min-w-0 truncate font-mono" aria-label={`Wallet address ${address}`}>
        {displayAddress}
      </span>
      {copyable && (
        <button
          type="button"
          onClick={handleCopy}
          className="relative inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-[#888] hover:bg-[#E5E5E5] hover:text-[#0F0F14] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#2DD4BF] group"
          aria-label={copied ? "Wallet address copied" : "Copy wallet address"}
        >
          {copied ? <Check size={11} /> : <Copy size={11} />}
          <span
            role="tooltip"
            className="pointer-events-none absolute bottom-full left-1/2 z-20 mb-1 hidden -translate-x-1/2 whitespace-nowrap rounded bg-[#0F0F14] px-2 py-1 text-[10px] text-white shadow-lg group-hover:block group-focus-visible:block"
          >
            {copied ? "Copied!" : "Copy address"}
          </span>
        </button>
      )}
      <span className="sr-only" aria-live="polite">
        {copied ? "Wallet address copied to clipboard" : ""}
      </span>
    </span>
  );
}
