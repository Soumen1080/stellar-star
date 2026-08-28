"use client";

import React from "react";
import { AlertTriangle } from "lucide-react";
import { useWallet } from "@/hooks/useWallet";
import { NETWORK_LABEL, networkLabel } from "@/lib/utils/constants";

/**
 * Surfaces a wallet/app network mismatch to the user wherever they are. This is
 * the user-facing half of invariant 2: the payment hooks *block* signing, and
 * this banner explains *why*, prominently and persistently, so a user on the
 * wrong network understands the block instead of hunting for a broken button.
 */
export function NetworkMismatchBanner() {
  const { isConnected, network, networkMismatch } = useWallet();

  if (!isConnected || !networkMismatch || !network) return null;

  return (
    <div className="fixed top-0 left-0 right-0 z-[300] bg-red-600 text-white text-sm font-medium px-4 py-2 flex items-center justify-center gap-2">
      <AlertTriangle size={16} className="shrink-0" />
      <span>
        Your wallet is on <strong>{networkLabel(network)}</strong>, but this app
        is configured for <strong>{NETWORK_LABEL}</strong>. Switch your wallet to{" "}
        {NETWORK_LABEL} and reconnect before making any payment.
      </span>
    </div>
  );
}
