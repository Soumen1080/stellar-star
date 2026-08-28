/**
 * Single source of truth for the wallet/app network-mismatch message and check.
 *
 * Kept as a pure function so the payment hooks (which *block* signing) and the
 * tests can both rely on identical logic. Returns null when the wallet is on the
 * app's network (or its network is unknown), and a clear, actionable message
 * otherwise.
 */

import { STELLAR_NETWORK, NETWORK_LABEL, networkLabel } from "@/lib/utils/constants";

export function networkMismatchMessage(
  walletNetwork: string | null | undefined
): string | null {
  if (walletNetwork && walletNetwork !== STELLAR_NETWORK) {
    return (
      `Your wallet is on ${networkLabel(walletNetwork)}, but this app is configured for ` +
      `${NETWORK_LABEL}. Switch your wallet to ${NETWORK_LABEL} and reconnect before paying.`
    );
  }
  return null;
}

/** True when the connected wallet is on a different network than the app. */
export function isWalletNetworkMismatched(
  walletNetwork: string | null | undefined
): boolean {
  return networkMismatchMessage(walletNetwork) !== null;
}
