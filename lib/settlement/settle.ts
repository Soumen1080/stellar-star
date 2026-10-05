import { toLedgerAmount } from "@/lib/money/assetPrecision";

/**
 * The settlement boundary: every direct ledger instruction is normalized to
 * the precision of its Stellar asset before an intent or transaction is built.
 */
export function prepareSettlementAmount(amount: string, asset: string): string {
  const normalized = toLedgerAmount(amount, asset);
  if (normalized.startsWith("-") || /^0(?:\.0+)?$/.test(normalized)) {
    throw new RangeError("Settlement amount must be greater than zero.");
  }
  return normalized;
}
