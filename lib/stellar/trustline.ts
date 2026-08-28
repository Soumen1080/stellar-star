import {
  TransactionBuilder,
  Operation,
  Account,
  Memo,
} from "@stellar/stellar-sdk";
import { toSdkAsset, type AssetRef } from "@/lib/stellar/assets";
import { HORIZON_URL, NETWORK_PASSPHRASE, TX_BASE_FEE, MEMO_PREFIX } from "@/lib/utils/constants";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";

export interface BuildChangeTrustParams {
  publicKey: string;
  asset: AssetRef;
  memoText?: string;
}

export interface BuildChangeTrustResult {
  xdr: string;
  memo: string;
}

/**
 * Builds an unsigned ChangeTrust transaction so a user can add a trustline.
 *
 * It defaults to the maximum limit. If the user cannot afford the 0.5 XLM reserve,
 * the network will reject it upon submission. The UI should check affordability beforehand.
 */
export async function buildChangeTrustTransaction({
  publicKey,
  asset,
  memoText,
}: BuildChangeTrustParams): Promise<BuildChangeTrustResult> {
  const acctRes = await fetch(`${HORIZON_URL}/accounts/${publicKey}?_ts=${Date.now()}`, {
    cache: "no-store",
    headers: { "Cache-Control": "no-cache" },
  });

  if (!acctRes.ok) {
    throw new Error(
      `Failed to load account from Horizon (${acctRes.status}). Check your Stellar address and network.`
    );
  }

  const acctData = (await acctRes.json()) as { sequence: string };
  const account = new Account(publicKey, acctData.sequence);

  const rawMemo = memoText ? `${MEMO_PREFIX}|${memoText}` : MEMO_PREFIX;
  const safeMemo = trimToMemoBytes(rawMemo);

  const tx = new TransactionBuilder(account, {
    fee: String(TX_BASE_FEE),
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset: toSdkAsset(asset),
      })
    )
    .addMemo(Memo.text(safeMemo))
    .setTimeout(30)
    .build();

  return { xdr: tx.toXDR(), memo: safeMemo };
}
