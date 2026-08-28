/**
 * Build an unsigned Stellar payment transaction (XDR).
 */
import {
  TransactionBuilder,
  Operation,
  Asset,
  Memo,
  Networks,
  Account,
} from "@stellar/stellar-sdk";
import {
  NETWORK_PASSPHRASE,
  MEMO_MAX_BYTES,
  MEMO_PREFIX,
  HORIZON_URL,
} from "@/lib/utils/constants";
import { toSdkAsset, parseAssetKey } from "@/lib/stellar/assets";
import { isQuoteFresh, type PricedPath } from "@/lib/stellar/pathPayment";
import { getSuggestedBaseFee } from "@/lib/stellar/fees";

export interface BuildTxParams {
  sourcePublicKey: string;
  destinationPublicKey: string;
  amount: string;
  asset?: string;
  memoText?: string;
}

export interface BuildTxResult {
  xdr: string;
  memo: string;
}

export function trimToMemoBytes(text: string, maxBytes: number = MEMO_MAX_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let result = text.slice(0, lo);
  if (result.length > 0) {
    const lastCharCode = result.charCodeAt(result.length - 1);
    if (lastCharCode >= 0xD800 && lastCharCode <= 0xDBFF) {
      result = result.slice(0, -1);
    }
  }
  return result;
}

export async function buildPaymentTransaction({
  sourcePublicKey,
  destinationPublicKey,
  amount,
  asset = "native",
  memoText,
}: BuildTxParams): Promise<BuildTxResult> {
  const acctRes = await fetch(
    `${HORIZON_URL}/accounts/${sourcePublicKey}?_ts=${Date.now()}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
  );
  if (!acctRes.ok) {
    throw new Error(
      `Failed to load account from Horizon (${acctRes.status}). Check your Stellar address and network.`
    );
  }
  const acctData = await acctRes.json() as { sequence: string };
  const account = new Account(sourcePublicKey, acctData.sequence);

  // Adaptive fee: clear surge pricing instead of a fixed 100-stroop minimum
  // that the network would reject when congested.
  const fee = await getSuggestedBaseFee();

  const rawMemo = memoText ? `${MEMO_PREFIX}|${memoText}` : MEMO_PREFIX;
  const safeMemo = trimToMemoBytes(rawMemo);

  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: toSdkAsset(parseAssetKey(asset)),
        amount,
      })
    )
    .addMemo(Memo.text(safeMemo))
    .setTimeout(30)
    .build();

  return { xdr: tx.toXDR(), memo: safeMemo };
}

export interface BuildPathPaymentParams {
  sourcePublicKey: string;
  destinationPublicKey: string;
  /** The priced route, including the spend limit the user confirmed. */
  path: PricedPath;
  memoText?: string;
}

/**
 * Builds a `pathPaymentStrictReceive` transaction.
 *
 * Strict-*receive* is the operation that matches a debt: `destAmount` is fixed,
 * so the recipient gets exactly what is owed or the transaction fails —
 * invariant 1, enforced by the network rather than by us checking afterwards.
 *
 * `sendMax` comes from the priced path the user confirmed, so the ceiling the
 * network enforces is the same number that was on screen (invariant 2). It is
 * never recomputed here: recomputing would let a stale or re-fetched quote
 * change the limit after the user agreed to it.
 */
export async function buildPathPaymentTransaction({
  sourcePublicKey,
  destinationPublicKey,
  path,
  memoText,
}: BuildPathPaymentParams): Promise<BuildTxResult> {
  if (!isQuoteFresh(path)) {
    throw new Error(
      "This exchange rate quote has expired. Refresh the quote before signing so the " +
        "spend limit reflects the current order book.",
    );
  }

  const acctRes = await fetch(
    `${HORIZON_URL}/accounts/${sourcePublicKey}?_ts=${Date.now()}`,
    { cache: "no-store", headers: { "Cache-Control": "no-cache" } }
  );
  if (!acctRes.ok) {
    throw new Error(
      `Failed to load account from Horizon (${acctRes.status}). Check your Stellar address and network.`
    );
  }
  const acctData = (await acctRes.json()) as { sequence: string };
  const account = new Account(sourcePublicKey, acctData.sequence);

  // Adaptive fee: same strategy as the direct payment path above.
  const fee = await getSuggestedBaseFee();

  const rawMemo = memoText ? `${MEMO_PREFIX}|${memoText}` : MEMO_PREFIX;
  const safeMemo = trimToMemoBytes(rawMemo);

  const tx = new TransactionBuilder(account, {
    fee,
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.pathPaymentStrictReceive({
        sendAsset: toSdkAsset(path.sourceAsset),
        sendMax: path.sendMax,
        destination: destinationPublicKey,
        destAsset: toSdkAsset(path.destinationAsset),
        destAmount: path.destinationAmount,
        path: path.path.map(toSdkAsset),
      })
    )
    .addMemo(Memo.text(safeMemo))
    .setTimeout(30)
    .build();

  return { xdr: tx.toXDR(), memo: safeMemo };
}
