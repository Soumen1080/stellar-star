export interface WalletState {
  publicKey: string | null;
  balance: string | null;
  isConnecting: boolean;
  isConnected: boolean;
  isLoadingBalance: boolean;
  isHydrated: boolean;
  network: string | null;
  /** The network this deployment is configured for (from STELLAR_NETWORK). */
  appNetwork: string;
  /** True when a wallet is connected on a network different from appNetwork. */
  networkMismatch: boolean;
  error: string | null;
  selectedWalletId: string | null;
}

export interface WalletActions {
  connect: () => Promise<void>;
  disconnect: () => void;
  refreshBalance: () => Promise<void>;
  clearError: () => void;
}

export type WalletContextType = WalletState & WalletActions;

export const WALLET_IDS = {
  FREIGHTER: "freighter",
  XBULL:     "xbull",
  LOBSTR:    "lobstr",
} as const;

export type WalletId = (typeof WALLET_IDS)[keyof typeof WALLET_IDS];
