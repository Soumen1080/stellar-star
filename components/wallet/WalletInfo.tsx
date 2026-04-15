"use client";

import React, { useState } from "react";
import { Copy, Check, RefreshCw, ExternalLink, LogOut } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { Spinner } from "@/components/ui/Spinner";
import { formatAddress, formatXLM } from "@/lib/utils";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import { cn } from "@/lib/utils";

/**
 * Full wallet info panel — intended for the dashboard sidebar or page header.
 * Shows: address, network, balance, copy/explorer/refresh/disconnect actions.
 */
export function WalletInfo({ className }: { className?: string }) {
  const {
    publicKey,
    balance,
    network,
    isConnected,
    isLoadingBalance,
    refreshBalance,
    disconnect,
  } = useWallet();

  const [copied, setCopied] = useState(false);

  if (!isConnected || !publicKey) return null;

  const explorerUrl = `${STELLAR_EXPLORER}/account/${publicKey}`;
  const isMainnet   = network === "PUBLIC";

  const handleCopy = () => {
    navigator.clipboard.writeText(publicKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className={cn(
        "bg-white border border-[#E5E5E5] rounded-2xl overflow-hidden",
        className
      )}
    >
      {/* Network bar */}
      <div
        className={cn(
          "flex items-center gap-2 px-4 py-2 border-b border-[#E5E5E5] text-xs font-semibold",
          isMainnet ? "bg-blue-50 text-blue-600" : "bg-[#2DD4BF]/10 text-[#134E4A]"
        )}
      >
        <span
          className={cn(
            "w-1.5 h-1.5 rounded-full",
            isMainnet ? "bg-blue-600" : "bg-[#134E4A] animate-pulse"
          )}
        />
        {isMainnet ? "Stellar Mainnet" : "Stellar Testnet"}
      </div>

      <div className="p-4 sm:p-5">
        {/* Address */}
        <div className="mb-4">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-[#AAA] mb-1">
            Wallet Address
          </p>
          <div className="flex items-start sm:items-center gap-2">
            <p className="text-sm font-mono font-semibold text-[#0F0F14] flex-1 truncate">
              {publicKey}
            </p>
          </div>
          <p className="text-xs text-[#888] font-mono mt-0.5">
            {formatAddress(publicKey, 10)}
          </p>
          <div className="flex flex-wrap items-center gap-2 mt-2">
            <button
              onClick={handleCopy}
              className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-[#555] hover:text-[#0F0F14] transition-colors"
            >
              {copied ? (
                <Check size={12} className="text-[#134E4A]" />
              ) : (
                <Copy size={12} />
              )}
              {copied ? "Copied!" : "Copy address"}
            </button>
            <span className="text-[#D0D0D0]">·</span>
            <a
              href={explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 px-1 py-1 text-xs font-medium text-[#555] hover:text-[#0F0F14] transition-colors"
            >
              <ExternalLink size={12} />
              View on Explorer
            </a>
          </div>
        </div>

        {/* Balance */}
        <div className="p-3 bg-[#F6F6F6] rounded-xl mb-3">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-[#AAA] mb-1">
                XLM Balance
              </p>
              {isLoadingBalance ? (
                <Spinner size={16} className="text-[#2DD4BF]" />
              ) : (
                <p className="text-2xl font-black text-[#0F0F14]">
                  {balance ? `${formatXLM(balance)}` : "—"}{" "}
                  <span className="text-sm font-semibold text-[#2DD4BF]">XLM</span>
                </p>
              )}
            </div>
            <button
              onClick={refreshBalance}
              disabled={isLoadingBalance}
              title="Refresh balance"
              className="w-8 h-8 rounded-xl flex items-center justify-center hover:bg-[#E5E5E5] transition-colors disabled:opacity-40"
            >
              <RefreshCw
                size={14}
                className={cn("text-[#888]", isLoadingBalance && "animate-spin")}
              />
            </button>
          </div>
        </div>

        {/* Disconnect */}
        <button
          onClick={disconnect}
          className="w-full flex items-center justify-center gap-2 py-2 text-sm font-medium text-red-500 rounded-xl border border-red-100 hover:bg-red-50 transition-colors"
        >
          <LogOut size={14} />
          Disconnect Wallet
        </button>
      </div>
    </div>
  );
}
