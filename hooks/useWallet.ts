"use client";

import { useWalletContext } from "@/context/WalletContext";

export function useWallet() {
  return useWalletContext();
}
