import {
  isConnected,
  isAllowed,
  requestAccess,
  getAddress as freighterGetAddress,
  signTransaction as freighterSignTransaction,
  getNetwork,
} from "@stellar/freighter-api";
import { STELLAR_NETWORK } from "@/lib/utils/constants";

// ─── Wallet IDs ───────────────────────────────────────────────────────────────

export const FREIGHTER_ID = "freighter" as const;
export const XBULL_ID     = "xbull"     as const;
export const LOBSTR_ID    = "lobstr"    as const;

export type WalletId =
  | typeof FREIGHTER_ID
  | typeof XBULL_ID
  | typeof LOBSTR_ID;

// ─── Network enum ─────────────────────────────────────────────────────────────

export enum WalletNetwork {
  PUBLIC  = "Public Global Stellar Network ; September 2015",
  TESTNET = "Test SDF Network ; September 2015",
}

// ─── Wallet descriptor ────────────────────────────────────────────────────────

export interface SupportedWallet {
  id: WalletId;
  name: string;
  logoUrl: string;
  installUrl: string;
  isInstalled: () => Promise<boolean>;
}

const SUPPORTED_WALLETS: SupportedWallet[] = [
  {
    id: FREIGHTER_ID,
    name:       "Freighter",
    logoUrl:    "/wallets/freighter.svg",
    installUrl: "https://www.freighter.app/",
    isInstalled: async () => {
      if (typeof window === "undefined") return false;
      try {
        const result = await isConnected();
        return !result.error && (result.isConnected ?? false);
      } catch {
        return false;
      }
    },
  },
  {
    id: XBULL_ID,
    name:       "xBull",
    logoUrl:    "/wallets/xbull.svg",
    installUrl: "https://xbull.app/",
    isInstalled: async () => {
      if (typeof window === "undefined") return false;
      return typeof (window as unknown as Record<string, unknown>).xBulls === "object" &&
             (window as unknown as Record<string, unknown>).xBulls !== null;
    },
  },
  {
    id: LOBSTR_ID,
    name:       "Lobstr",
    logoUrl:    "/wallets/lobstr.svg",
    installUrl: "https://lobstr.co/",
    isInstalled: async () => {
      if (typeof window === "undefined") return false;
      return typeof (window as unknown as Record<string, unknown>).lobstr === "object" &&
             (window as unknown as Record<string, unknown>).lobstr !== null;
    },
  },
];

// ─── Kit options ──────────────────────────────────────────────────────────────

export interface StellarWalletsKitOptions {
  network: WalletNetwork;
  selectedWalletId?: WalletId;
}

export interface WalletModalOptions {
  onWalletSelected: (wallet: SupportedWallet) => Promise<void> | void;
  onClosed?: () => void;
  modalTitle?: string;
  notAvailableText?: string;
}

export interface SignTransactionOptions {
  address: string;
  networkPassphrase?: string;
}

export interface GetAddressResult {
  address: string;
}

export interface SignTransactionResult {
  signedTxXdr: string;
}

// ─── Kit class ────────────────────────────────────────────────────────────────

export class StellarWalletsKit {
  private readonly network: WalletNetwork;
  private selectedWalletId: WalletId;
  private modalContainer: HTMLElement | null = null;

  constructor(opts: StellarWalletsKitOptions) {
    this.network         = opts.network;
    this.selectedWalletId = opts.selectedWalletId ?? FREIGHTER_ID;
  }

  // ── Wallet selection ────────────────────────────────────────────────────────

  setWallet(id: WalletId): void {
    this.selectedWalletId = id;
  }

  getSelectedWalletId(): WalletId {
    return this.selectedWalletId;
  }

  // ── Modal ───────────────────────────────────────────────────────────────────

  async openModal(opts: WalletModalOptions): Promise<void> {
    if (typeof window === "undefined") {
      throw new Error("openModal requires a browser environment.");
    }

    return new Promise<void>((resolve) => {
      this.injectModal(opts, resolve);
    });
  }

  private injectModal(opts: WalletModalOptions, resolve: () => void): void {
    this.destroyModal();

    const title       = opts.modalTitle      ?? "Connect Wallet";
    const unavailText = opts.notAvailableText ?? "Not installed";

    const overlay = document.createElement("div");
    overlay.setAttribute("data-stellar-star-wallet-modal", "true");
    Object.assign(overlay.style, {
      position:        "fixed",
      inset:           "0",
      background:      "rgba(0,0,0,0.55)",
      backdropFilter:  "blur(4px)",
      display:         "flex",
      alignItems:      "center",
      justifyContent:  "center",
      zIndex:          "99999",
      fontFamily:      "Poppins, system-ui, sans-serif",
    } as Partial<CSSStyleDeclaration>);

    const card = document.createElement("div");
    Object.assign(card.style, {
      background:   "#fff",
      borderRadius: "20px",
      padding:      "28px 24px",
      width:        "360px",
      maxWidth:     "calc(100vw - 32px)",
      boxShadow:    "0 24px 80px -12px rgba(0,0,0,0.25)",
    } as Partial<CSSStyleDeclaration>);

    const header = document.createElement("div");
    Object.assign(header.style, {
      display:        "flex",
      justifyContent: "space-between",
      alignItems:     "center",
      marginBottom:   "20px",
    } as Partial<CSSStyleDeclaration>);

    const titleEl = document.createElement("h2");
    titleEl.textContent = title;
    Object.assign(titleEl.style, {
      fontSize:   "17px",
      fontWeight: "700",
      color:      "#0F0F14",
      margin:     "0",
    } as Partial<CSSStyleDeclaration>);

    const closeBtn = document.createElement("button");
    closeBtn.innerHTML = "&#x2715;";
    Object.assign(closeBtn.style, {
      background:  "none",
      border:      "none",
      fontSize:    "18px",
      color:       "#999",
      cursor:      "pointer",
      padding:     "4px",
      lineHeight:  "1",
    } as Partial<CSSStyleDeclaration>);
    closeBtn.addEventListener("click", () => {
      this.destroyModal();
      opts.onClosed?.();
      resolve();
    });

    header.appendChild(titleEl);
    header.appendChild(closeBtn);

    const list = document.createElement("div");
    Object.assign(list.style, {
      display:       "flex",
      flexDirection: "column",
      gap:           "10px",
    } as Partial<CSSStyleDeclaration>);

    SUPPORTED_WALLETS.forEach((wallet) => {
      const btn = document.createElement("button");
      Object.assign(btn.style, {
        display:       "flex",
        alignItems:    "center",
        gap:           "14px",
        padding:       "14px 16px",
        border:        "1.5px solid #E5E5E5",
        borderRadius:  "12px",
        background:    "#fff",
        cursor:        "pointer",
        width:         "100%",
        textAlign:     "left",
        transition:    "border-color 0.15s, background 0.15s",
      } as Partial<CSSStyleDeclaration>);

      btn.addEventListener("mouseenter", () => {
        btn.style.borderColor = "#2DD4BF";
        btn.style.background  = "#F0FDFA";
      });
      btn.addEventListener("mouseleave", () => {
        btn.style.borderColor = "#E5E5E5";
        btn.style.background  = "#fff";
      });

      const img = document.createElement("img");
      img.src   = wallet.logoUrl;
      img.alt   = wallet.name;
      Object.assign(img.style, { width: "32px", height: "32px", borderRadius: "8px" });

      const nameEl = document.createElement("span");
      nameEl.textContent = wallet.name;
      Object.assign(nameEl.style, {
        fontSize:   "15px",
        fontWeight: "600",
        color:      "#0F0F14",
        flex:       "1",
      } as Partial<CSSStyleDeclaration>);

      const badge = document.createElement("span");
      Object.assign(badge.style, {
        fontSize:     "11px",
        fontWeight:   "600",
        padding:      "3px 8px",
        borderRadius: "6px",
        background:   "#F0F0F0",
        color:        "#999",
      } as Partial<CSSStyleDeclaration>);
      badge.textContent = "Checking…";

      wallet.isInstalled().then((available) => {
        if (available) {
          badge.textContent     = "Available";
          badge.style.background = "#ECFDF5";
          badge.style.color      = "#059669";
          btn.style.cursor       = "pointer";
        } else {
          badge.textContent     = unavailText;
          badge.style.background = "#FEF2F2";
          badge.style.color      = "#DC2626";
          btn.style.cursor       = "not-allowed";
          btn.style.opacity      = "0.6";
        }
      });

      btn.appendChild(img);
      btn.appendChild(nameEl);
      btn.appendChild(badge);

      btn.addEventListener("click", async () => {
        wallet.isInstalled().then(async (available) => {
          if (!available) {
            window.open(wallet.installUrl, "_blank", "noopener,noreferrer");
            return;
          }
          this.destroyModal();
          try {
            await opts.onWalletSelected(wallet);
          } finally {
            resolve();
          }
        });
      });

      list.appendChild(btn);
    });

    card.appendChild(header);
    card.appendChild(list);
    overlay.appendChild(card);

    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) {
        this.destroyModal();
        opts.onClosed?.();
        resolve();
      }
    });

    document.body.appendChild(overlay);
    this.modalContainer = overlay;
  }

  private destroyModal(): void {
    if (this.modalContainer && document.body.contains(this.modalContainer)) {
      document.body.removeChild(this.modalContainer);
    }
    this.modalContainer = null;
  }

  // ── Address ─────────────────────────────────────────────────────────────────

  async getAddress(): Promise<GetAddressResult> {
    if (this.selectedWalletId === FREIGHTER_ID) return this.freighterGetAddress();
    if (this.selectedWalletId === XBULL_ID)     return this.xBullGetAddress();
    if (this.selectedWalletId === LOBSTR_ID)    return this.lobstrGetAddress();
    throw new Error(`Wallet "${this.selectedWalletId}" is not supported.`);
  }

  private async freighterGetAddress(): Promise<GetAddressResult> {
    const allowed = await isAllowed();
    if (!allowed.error && allowed.isAllowed) {
      const result = await freighterGetAddress();
      if (!result.error && result.address) return { address: result.address };
    }
    const result = await requestAccess();
    if (result.error) {
      const msg = String(result.error);
      if (/reject|denied/i.test(msg)) throw new Error("Connection rejected in Freighter.");
      throw new Error(msg || "Freighter access denied.");
    }
    if (!result.address) throw new Error("Freighter did not return an address.");
    return { address: result.address };
  }

  private async xBullGetAddress(): Promise<GetAddressResult> {
    const xbull = (window as unknown as Record<string, unknown>).xBulls as Record<string, (...a: unknown[]) => Promise<unknown>>;
    if (!xbull) throw new Error("xBull extension is not installed.");
    const result = (await xbull.getPublicKey()) as { publicKey?: string };
    if (!result.publicKey) throw new Error("xBull did not return a public key.");
    return { address: result.publicKey };
  }

  private async lobstrGetAddress(): Promise<GetAddressResult> {
    const lobstr = (window as unknown as Record<string, unknown>).lobstr as Record<string, (...a: unknown[]) => Promise<unknown>>;
    if (!lobstr) throw new Error("Lobstr extension is not installed.");
    const result = (await lobstr.getPublicKey()) as { publicKey?: string };
    if (!result.publicKey) throw new Error("Lobstr did not return a public key.");
    return { address: result.publicKey };
  }

  // ── Sign transaction ────────────────────────────────────────────────────────

  async signTransaction(xdr: string, opts: SignTransactionOptions): Promise<SignTransactionResult> {
    if (this.selectedWalletId === FREIGHTER_ID) return this.freighterSign(xdr, opts);
    if (this.selectedWalletId === XBULL_ID)     return this.xBullSign(xdr, opts);
    if (this.selectedWalletId === LOBSTR_ID)    return this.lobstrSign(xdr, opts);
    throw new Error(`Wallet "${this.selectedWalletId}" does not support signing.`);
  }

  private async freighterSign(xdr: string, opts: SignTransactionOptions): Promise<SignTransactionResult> {
    const passphrase = opts.networkPassphrase ?? this.network;
    const result = await freighterSignTransaction(xdr, { networkPassphrase: passphrase });
    if ("error" in result && result.error) {
      const msg = String(result.error);
      if (/reject|denied|cancel|declined/i.test(msg)) throw new Error("Transaction cancelled in Freighter.");
      throw new Error(msg || "Freighter signing failed.");
    }
    const signedTxXdr = (result as { signedTxXdr: string }).signedTxXdr;
    if (!signedTxXdr) throw new Error("Freighter returned an empty signed transaction.");
    return { signedTxXdr };
  }

  private async xBullSign(xdr: string, opts: SignTransactionOptions): Promise<SignTransactionResult> {
    const xbull = (window as unknown as Record<string, unknown>).xBulls as Record<string, (...a: unknown[]) => Promise<unknown>>;
    if (!xbull) throw new Error("xBull extension is not installed.");
    const passphrase = opts.networkPassphrase ?? this.network;
    const result = (await xbull.signXDR(xdr, { network: passphrase })) as { signedXDR?: string };
    if (!result.signedXDR) throw new Error("xBull did not return a signed transaction.");
    return { signedTxXdr: result.signedXDR };
  }

  private async lobstrSign(xdr: string, opts: SignTransactionOptions): Promise<SignTransactionResult> {
    const lobstr = (window as unknown as Record<string, unknown>).lobstr as Record<string, (...a: unknown[]) => Promise<unknown>>;
    if (!lobstr) throw new Error("Lobstr extension is not installed.");
    const passphrase = opts.networkPassphrase ?? this.network;
    const result = (await lobstr.signTransaction(xdr, { network: passphrase })) as { signedXDR?: string };
    if (!result.signedXDR) throw new Error("Lobstr did not return a signed transaction.");
    return { signedTxXdr: result.signedXDR };
  }

  // ── Network ─────────────────────────────────────────────────────────────────

  async getNetworkFromWallet(): Promise<string> {
    if (this.selectedWalletId === FREIGHTER_ID) {
      try {
        const result = await getNetwork();
        if ("error" in result && result.error) return STELLAR_NETWORK;
        return (result as { network: string }).network ?? STELLAR_NETWORK;
      } catch {
        return STELLAR_NETWORK;
      }
    }
    return STELLAR_NETWORK;
  }

  static getSupportedWallets(): SupportedWallet[] {
    return SUPPORTED_WALLETS;
  }
}

// ─── SSR-safe singleton ───────────────────────────────────────────────────────

let _instance: StellarWalletsKit | null = null;

export function getWalletsKit(): StellarWalletsKit {
  if (typeof window === "undefined") {
    throw new Error("StellarWalletsKit requires a browser environment.");
  }
  if (!_instance) {
    _instance = new StellarWalletsKit({
      network:
        STELLAR_NETWORK === "PUBLIC"
          ? WalletNetwork.PUBLIC
          : WalletNetwork.TESTNET,
      selectedWalletId: FREIGHTER_ID,
    });
  }
  return _instance;
}
