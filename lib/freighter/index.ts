import { getWalletsKit } from "@/lib/stellar/walletsKit";
import { isConnected } from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { WalletNetwork } from "@/lib/stellar/walletsKit";

function matchingPassphrase(network: string | null): string | null {
  if (!network) return null;
  if (network === "TESTNET" || network === WalletNetwork.TESTNET) return WalletNetwork.TESTNET;
  if (network === "PUBLIC" || network === WalletNetwork.PUBLIC) return WalletNetwork.PUBLIC;
  return network;
}

async function copyXdrFallback(xdr: string): Promise<never> {
  try {
    if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(xdr);
      throw new Error("Wallet capability check failed. Unsigned XDR was copied; open a compatible Stellar wallet and import it to sign.");
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("Wallet capability check failed.")) throw err;
  }
  throw new Error("No compatible wallet can safely sign this transaction. Connect Freighter, xBull, or Lobstr, then retry.");
}

export async function isFreighterInstalled(): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    const result = await isConnected();
    return !result.error && (result.isConnected ?? false);
  } catch {
    return false;
  }
}

export async function connectFreighter(): Promise<string> {
  const kit = getWalletsKit();
  let resolvedAddress = "";
  let connectError: Error | null = null;

  await kit.openModal({
    modalTitle:       "Connect Your Stellar Wallet",
    notAvailableText: "Install extension",
    onWalletSelected: async (wallet) => {
      kit.setWallet(wallet.id);
      const { address } = await kit.getAddress();
      resolvedAddress = address;
    },
    onClosed: () => {
      if (!resolvedAddress) {
        connectError = new Error("Modal closed without selecting a wallet.");
      }
    },
  });

  if (connectError) throw connectError;
  if (!resolvedAddress) throw new Error("No wallet address returned - please try again.");
  return resolvedAddress;
}

export async function signXDR(
  xdr: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
  expectedAddress?: string,
): Promise<string> {
  const kit = getWalletsKit();
  if (!expectedAddress) return copyXdrFallback(xdr);
  const [active, capabilities] = await Promise.all([
    kit.getAddress().catch(() => null),
    kit.detectCapabilities(kit.getSelectedWalletId()),
  ]);
  if (!capabilities.installed || !capabilities.canReadAddress || !capabilities.canSignTransactions || !active) return copyXdrFallback(xdr);
  if (active.address !== expectedAddress) throw new Error("The active wallet address changed. Reconnect the intended account before signing.");
  const activeNetwork = matchingPassphrase(await kit.getNetworkFromWallet());
  if (!activeNetwork || activeNetwork !== networkPassphrase) return copyXdrFallback(xdr);
  let signedTxXdr: string;
  try {
    ({ signedTxXdr } = await kit.signTransaction(xdr, { address: expectedAddress, networkPassphrase }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Wallet signing is unsupported.";
    if (/unsupported|not installed|not supported|cannot sign/i.test(message)) return copyXdrFallback(xdr);
    throw error;
  }
  if (!signedTxXdr) throw new Error("The wallet returned an empty signed transaction.");
  return signedTxXdr;
}

export async function getFreighterNetwork(): Promise<string | null> {
  try {
    return await getWalletsKit().getNetworkFromWallet();
  } catch {
    return null;
  }
}
