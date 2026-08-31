import {
  TransactionBuilder,
  Operation,
  Account,
  Memo,
} from "@stellar/stellar-sdk";
import { toSdkAsset, isNative, formatAssetLabel, type AssetRef } from "@/lib/stellar/assets";
import { HORIZON_URL, NETWORK_PASSPHRASE, TX_BASE_FEE, MEMO_PREFIX } from "@/lib/utils/constants";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import {
  getAccountState,
  trustlineReserveStroops,
  stroopsToXlm,
} from "@/lib/stellar/accountState";

export interface BuildChangeTrustParams {
  publicKey: string;
  asset: AssetRef;
  memoText?: string;
  /**
   * Escape hatch for callers that have already established affordability from a
   * fresh account read (the UI does). Skips the extra Horizon round-trip.
   * Defaults to false: the safe thing must be the default.
   */
  skipAffordabilityCheck?: boolean;
}

export interface BuildChangeTrustResult {
  xdr: string;
  memo: string;
  /** Reserve this trustline will lock, in stroops. Disclose before signing. */
  reserveStroops: bigint;
}

/** Thrown when the account cannot cover the reserve the new trustline requires. */
export class InsufficientReserveError extends Error {
  readonly requiredStroops: bigint;
  readonly spendableStroops: bigint;

  constructor(requiredStroops: bigint, spendableStroops: bigint) {
    super(
      `Adding this trustline locks ${stroopsToXlm(requiredStroops)} XLM in reserve, ` +
        `but only ${stroopsToXlm(spendableStroops)} XLM is spendable. ` +
        "Fund the account before adding the trustline.",
    );
    this.name = "InsufficientReserveError";
    this.requiredStroops = requiredStroops;
    this.spendableStroops = spendableStroops;
  }
}

/**
 * Builds an unsigned ChangeTrust transaction so a user can add a trustline.
 *
 * Two guards that used to be the caller's problem are enforced here, because
 * "the UI should check beforehand" is not a guarantee — any caller that forgets
 * puts the user through a wallet signature that the network then rejects:
 *
 *  - **Native XLM is refused.** Every account holds XLM intrinsically; there is
 *    no trustline to add, and `changeTrust` on the native asset is invalid.
 *  - **Affordability is verified against live ledger state** before an XDR is
 *    produced, so an unaffordable attempt fails here rather than after the user
 *    has signed. The required reserve is read from the network base reserve,
 *    never hardcoded.
 *
 * The limit is left unset, which the SDK encodes as the maximum int64. That is
 * deliberate: a lower limit is a policy this app has no basis to choose for the
 * user, and a too-low limit silently bounces later payments.
 */
export async function buildChangeTrustTransaction({
  publicKey,
  asset,
  memoText,
  skipAffordabilityCheck = false,
}: BuildChangeTrustParams): Promise<BuildChangeTrustResult> {
  if (isNative(asset)) {
    throw new Error(
      "XLM does not require a trustline — every Stellar account can hold it natively.",
    );
  }

  // Reserve is computed from live ledger parameters, and doubles as the
  // pre-signature affordability gate.
  const state = await getAccountState(publicKey);
  const reserveStroops = trustlineReserveStroops(state.baseReserveStroops);

  if (!skipAffordabilityCheck) {
    if (state.status === "unfunded") {
      throw new Error(
        `Account ${publicKey} does not exist yet. It must be funded before it can ` +
          `hold ${formatAssetLabel(asset)}.`,
      );
    }
    if (state.spendableStroops < reserveStroops) {
      throw new InsufficientReserveError(reserveStroops, state.spendableStroops);
    }
  }

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

  return { xdr: tx.toXDR(), memo: safeMemo, reserveStroops };
}
