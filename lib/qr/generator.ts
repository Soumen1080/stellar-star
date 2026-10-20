/**
 * SEP-0007 compliant QR payment URI builder.
 * web+stellar:pay? URIs are understood by Freighter, Lobstr, and most
 * Stellar wallets - scanning the QR auto-fills the payment form.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

import { StrKey } from "@stellar/stellar-sdk";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";

export interface QRPaymentData {
  /** Destination Stellar address (G...) */
  destination: string;
  /** Amount as string e.g. "300.0000000" */
  amount: string;
  /** Human-readable memo - will be truncated to 28 bytes */
  memo?: string;
  /** Optional asset code (e.g. "USDC") for non-native payments */
  assetCode?: string;
  /** Optional asset issuer public key for non-native payments */
  assetIssuer?: string;
  /**
   * Network the payment is for (SEP-0007 `network_passphrase`). Wallets on a
   * different network refuse the request instead of paying on the wrong one.
   */
  networkPassphrase?: string;
  /** Human-readable preview a wallet shows before signing (max 300 chars). */
  msg?: string;
}

/**
 * Returns a `web+stellar:pay?...` URI.
 * Any SEP-0007-compatible wallet can parse this to pre-fill the payment.
 */
export function buildQRPaymentURI({
  destination,
  amount,
  memo,
  assetCode,
  assetIssuer,
  networkPassphrase,
  msg,
}: QRPaymentData): string {
  const cleanDest = (destination ?? "").trim();
  if (cleanDest && !StrKey.isValidEd25519PublicKey(cleanDest)) {
    throw new Error(`Invalid destination address: ${destination} is not a Stellar account (G...).`);
  }

  const params = new URLSearchParams({
    destination: cleanDest,
    amount,
  });

  if (assetCode && assetCode !== "XLM" && assetCode !== "native") {
    params.set("asset_code", assetCode);
    if (assetIssuer) {
      if (!StrKey.isValidEd25519PublicKey(assetIssuer.trim())) {
        throw new Error(`Invalid asset issuer address: ${assetIssuer}`);
      }
      params.set("asset_issuer", assetIssuer.trim());
    }
  }

  if (memo) {
    const finalMemo = trimToMemoBytes(memo, 28);
    params.set("memo", finalMemo);
    params.set("memo_type", "MEMO_TEXT");
  }

  if (networkPassphrase) {
    params.set("network_passphrase", networkPassphrase);
  }
  if (msg) {
    params.set("msg", msg.slice(0, 300));
  }

  return `web+stellar:pay?${params.toString()}`;
}
