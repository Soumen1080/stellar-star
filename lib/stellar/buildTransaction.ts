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
  TX_BASE_FEE,
  MEMO_MAX_BYTES,
  MEMO_PREFIX,
  HORIZON_URL,
} from "@/lib/utils/constants";

export interface BuildTxParams {
  sourcePublicKey: string;
  destinationPublicKey: string;
  amount: string;
  memoText?: string;
}

export interface BuildTxResult {
  xdr: string;
  memo: string;
}

function trimToMemoBytes(text: string, maxBytes: number = MEMO_MAX_BYTES): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let lo = 0, hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (encoder.encode(text.slice(0, mid)).length <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

export async function buildPaymentTransaction({
  sourcePublicKey,
  destinationPublicKey,
  amount,
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

  const rawMemo = memoText ? `${MEMO_PREFIX}|${memoText}` : MEMO_PREFIX;
  const safeMemo = trimToMemoBytes(rawMemo);

  const tx = new TransactionBuilder(account, {
    fee: String(TX_BASE_FEE),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: destinationPublicKey,
        asset: Asset.native(),
        amount,
      })
    )
    .addMemo(Memo.text(safeMemo))
    .setTimeout(30)
    .build();

  return { xdr: tx.toXDR(), memo: safeMemo };
}
