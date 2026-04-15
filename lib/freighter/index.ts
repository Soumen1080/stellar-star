import { getWalletsKit } from "@/lib/stellar/walletsKit";
import { isConnected } from "@stellar/freighter-api";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

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
  if (!resolvedAddress) throw new Error("No wallet address returned — please try again.");
  return resolvedAddress;
}

export async function signXDR(
  xdr: string,
  networkPassphrase: string = NETWORK_PASSPHRASE,
): Promise<string> {
  const kit = getWalletsKit();
  const { signedTxXdr } = await kit.signTransaction(xdr, {
    address: "",
    networkPassphrase,
  });
  if (!signedTxXdr) throw new Error("The wallet returned an empty signed transaction.");
  return signedTxXdr;
}

export async function getFreighterNetwork(): Promise<string> {
  try {
    return await getWalletsKit().getNetworkFromWallet();
  } catch {
    return "TESTNET";
  }
}
