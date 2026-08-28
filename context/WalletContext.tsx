"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { getFreighterNetwork, isFreighterInstalled } from "@/lib/freighter";
import { getWalletsKit, FREIGHTER_ID, StellarWalletsKit, type WalletId } from "@/lib/stellar/walletsKit";
import { getXLMBalance } from "@/lib/stellar/getBalance";
import {
  LS_PUBLIC_KEY,
  STELLAR_NETWORK,
  NETWORK_LABEL,
  networkLabel,
} from "@/lib/utils/constants";
import { reportError } from "@/lib/observability/reportError";
import type { WalletContextType } from "@/types/wallet";
import { useToast } from "@/components/ui/Toast";
import { resetSupabaseClient } from "@/lib/supabase/client";


const WalletContext = createContext<WalletContextType | null>(null);
WalletContext.displayName = "WalletContext";


export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [publicKey, setPublicKey]           = useState<string | null>(null);
  const [balance, setBalance]               = useState<string | null>(null);
  const [network, setNetwork]               = useState<string | null>(null);
  const [isConnecting, setIsConnecting]     = useState(false);
  const [isLoadingBalance, setLoadingBal]   = useState(false);
  const [isHydrated, setIsHydrated]         = useState(false);
  const [error, setError]                   = useState<string | null>(null);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);

  const isConnected = !!publicKey;
  const didMount    = useRef(false);
  const { error: toastError, success: toastSuccess, info: toastInfo } = useToast();

  // The network this deployment is configured for. A connected wallet whose
  // `network` differs from this is on the wrong network and must be blocked
  // from signing (see the payment hooks and NetworkMismatchBanner).
  const appNetwork = STELLAR_NETWORK;

  /**
   * Live re-check of the wallet's network while connected.
   *
   * Freighter lets the user switch networks without reconnecting, which would
   * leave `network` stale and a mismatch undetected. We re-read it on an
   * interval so a mid-session switch is caught before the next signing.
   */
  useEffect(() => {
    if (typeof window === "undefined" || !isConnected) return;
    let active = true;
    const check = async () => {
      try {
        const net = await getFreighterNetwork().catch(() => "TESTNET");
        if (active) setNetwork(net);
      } catch {
        /* keep last known network */
      }
    };
    check();
    const id = setInterval(check, 10_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [isConnected]);

  // Surface a wallet/app network mismatch exactly once, when it first appears.
  const prevMismatch = useRef(false);
  const networkMismatch =
    isConnected && network != null && network !== appNetwork;

  useEffect(() => {
    if (networkMismatch && !prevMismatch.current && network) {
      const msg =
        `Your wallet is on ${networkLabel(network)}, but this app is configured for ` +
        `${NETWORK_LABEL}. Switch your wallet to ${NETWORK_LABEL} and reconnect before paying.`;
      toastError("Network mismatch", msg);
      reportError("wallet.network-mismatch", new Error(msg), {
        walletNetwork: network,
        appNetwork,
      });
    }
    prevMismatch.current = networkMismatch;
  }, [networkMismatch, network, appNetwork, toastError]);

  const fetchBalance = useCallback(async (pk: string, silent = false) => {
    if (!silent) setLoadingBal(true);
    try {
      const bal = await getXLMBalance(pk);
      setBalance(bal);
    } catch {
      // keep last known balance on transient errors
    } finally {
      if (!silent) setLoadingBal(false);
    }
  }, []);

  const hydrateNetwork = useCallback(async () => {
    try {
      const net = await getFreighterNetwork();
      setNetwork(net);
    } catch {
      setNetwork("TESTNET");
    }
  }, []);

  // ── Auto-reconnect from localStorage ───────────────────────────────────────

  useEffect(() => {
    if (didMount.current) return;
    didMount.current = true;

    const savedKey = typeof window !== "undefined"
      ? localStorage.getItem(LS_PUBLIC_KEY)
      : null;
    const savedWalletId = typeof window !== "undefined"
      ? localStorage.getItem("StellarStar:walletId") as WalletId | null
      : null;

    if (!savedKey) {
      // No saved key - nothing to restore, mark hydration done immediately
      setIsHydrated(true);
      return;
    }

    const walletId = savedWalletId || FREIGHTER_ID;
    const wallets = StellarWalletsKit.getSupportedWallets();
    const wallet = wallets.find((w) => w.id === walletId) || wallets[0];

    // Verify selected wallet is still available/installed before auto-restoring
    wallet.isInstalled().then((installed) => {
      if (!installed) {
        localStorage.removeItem(LS_PUBLIC_KEY);
        localStorage.removeItem("StellarStar:walletId");
      } else {
        // Restore silently - do not re-prompt the user
        getWalletsKit().setWallet(walletId);
        setPublicKey(savedKey);
        setSelectedWalletId(walletId);
        fetchBalance(savedKey);
        hydrateNetwork();
      }
      // Either way, hydration check is done - allow WalletGuard to render
      setIsHydrated(true);
    });
  }, [fetchBalance, hydrateNetwork]);

  useEffect(() => {
    if (!publicKey) return;

    const interval = setInterval(() => {
      fetchBalance(publicKey, true);
    }, 15_000);

    const handleVisibility = () => {
      if (document.visibilityState === "visible") fetchBalance(publicKey, true);
    };
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [publicKey, fetchBalance]);


  const connect = useCallback(async () => {
    setIsConnecting(true);
    setError(null);

    try {
      // ── E2E bypass: skip the wallet-selection modal when a test wallet is
      //    injected by Playwright's mockWallet() helper.  This avoids race
      //    conditions in the async modal click-handler chain.
      const e2eWallet = typeof window !== "undefined"
        ? (window as unknown as { __E2E_WALLET__?: { address: string } }).__E2E_WALLET__
        : undefined;

      if (e2eWallet) {
        const kit = getWalletsKit();
        kit.setWallet(FREIGHTER_ID);

        setPublicKey(e2eWallet.address);
        setNetwork("TESTNET");
        setSelectedWalletId(FREIGHTER_ID);
        localStorage.setItem(LS_PUBLIC_KEY, e2eWallet.address);
        localStorage.setItem("StellarStar:walletId", FREIGHTER_ID);
        return;
      }

      const kit = getWalletsKit();
      let resolvedAddress = "";
      let selectedId: WalletId = FREIGHTER_ID;
      let walletError: Error | null = null;

      await kit.openModal({
        modalTitle: "Connect Your Stellar Wallet",
        notAvailableText: "Install extension",

        onWalletSelected: async (wallet) => {
          kit.setWallet(wallet.id);
          selectedId = wallet.id;
          const { address } = await kit.getAddress();
          resolvedAddress = address;
        },

        onClosed: () => {
          if (!resolvedAddress) walletError = new Error("Wallet selection cancelled.");
        },
      });

      if (walletError || !resolvedAddress) return;

      const net = await getFreighterNetwork().catch(() => "TESTNET");

      setPublicKey(resolvedAddress);
      setNetwork(net);
      setSelectedWalletId(selectedId);
      localStorage.setItem(LS_PUBLIC_KEY, resolvedAddress);
      localStorage.setItem("StellarStar:walletId", selectedId);
      toastSuccess(
        "Wallet connected",
          `${resolvedAddress.slice(0, 6)}...${resolvedAddress.slice(-4)} on ${networkLabel(net)}`
      );

      fetchBalance(resolvedAddress);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to connect wallet.";
      const isCancelled =
        msg.toLowerCase().includes("cancel") ||
        msg.toLowerCase().includes("closed without");
      if (!isCancelled) {
        setError(msg);
        toastError("Connection failed", msg);
      }
    } finally {
      setIsConnecting(false);
    }
  }, [fetchBalance, toastSuccess, toastError]);


  const disconnect = useCallback(() => {
    setPublicKey(null);
    setBalance(null);
    setNetwork(null);
    setError(null);
    setSelectedWalletId(null);
    toastInfo("Wallet disconnected");
    localStorage.removeItem(LS_PUBLIC_KEY);
    localStorage.removeItem("StellarStar:walletId");
    // Drops the wallet session and every open Realtime channel so the next
    // wallet starts from a clean subscription set.
    resetSupabaseClient();
  }, [toastInfo]);


  const refreshBalance = useCallback(async () => {
    if (!publicKey) return;
    await fetchBalance(publicKey);
  }, [publicKey, fetchBalance]);

  const clearError = useCallback(() => setError(null), []);

  const value: WalletContextType = {
    publicKey,
    balance,
    network,
    appNetwork,
    networkMismatch,
    isConnected,
    isConnecting,
    isHydrated,
    isLoadingBalance,
    error,
    selectedWalletId,
    connect,
    disconnect,
    refreshBalance,
    clearError,
  };

  return (
    <WalletContext.Provider value={value}>{children}</WalletContext.Provider>
  );
}

export function useWalletContext(): WalletContextType {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWalletContext must be used within <WalletProvider />");
  return ctx;
}
