/**
 * SEP-0007 compliant QR payment URI builder.
 * web+stellar:pay? URIs are understood by Freighter, Lobstr, and most
 * Stellar wallets — scanning the QR auto-fills the payment form.
 *
 * Spec: https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0007.md
 */

export interface QRPaymentData {
  /** Destination Stellar address (G…) */
  destination: string;
  /** XLM amount as string e.g. "300.0000000" */
  amount: string;
  /** Human-readable memo — will be truncated to 28 bytes */
  memo?: string;
}

/**
 * Returns a `web+stellar:pay?…` URI.
 * Any SEP-0007-compatible wallet can parse this to pre-fill the payment.
 */
export function buildQRPaymentURI({ destination, amount, memo }: QRPaymentData): string {
  const params = new URLSearchParams({
    destination,
    amount,
  });
  if (memo) {
    params.set("memo", memo);
    params.set("memo_type", "MEMO_TEXT");
  }
  return `web+stellar:pay?${params.toString()}`;
}
