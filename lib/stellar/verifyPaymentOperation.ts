/**
 * Matching a Horizon operation against a settlement claim.
 *
 * Shared by the client-side check and the attestation oracle, so both agree on
 * what counts as proof of payment.
 *
 * ## Why this module exists
 *
 * A path payment settles a debt just as validly as a direct payment, but
 * Horizon records it as `path_payment_strict_receive` with a different record
 * shape. Any check asserting `op.type === "payment"` silently rejects a
 * perfectly good settlement — the payer's money is gone and the app says the
 * debt is unpaid. That is invariant 4, and it is the reason matching lives here
 * rather than being inlined at each call site with a hard-coded type string.
 *
 * ## What is asserted, and what deliberately is not
 *
 * For a path payment the fields that matter are the **destination** ones:
 * `asset_type`/`asset_code`/`asset_issuer` and `amount` describe what the
 * recipient actually received. The `source_*` fields describe what the sender
 * spent, which for a path payment is a different asset entirely and is *not*
 * what the debt was denominated in. Asserting against the source would reject
 * every path payment; asserting against the destination is the correct check
 * for both operation types.
 */

import {
  assetEquals,
  fromHorizonFields,
  isNative,
  type AssetRef,
} from "@/lib/stellar/assets";

/** The subset of a Horizon operation record this module reads. */
export interface HorizonOperationRecord {
  type?: string;
  source_account?: string;
  from?: string;
  to?: string;
  /** Direct payment: the asset sent. Path payment: the asset *received*. */
  asset_type?: string;
  asset_code?: string | null;
  asset_issuer?: string | null;
  /** Direct payment: amount sent. Path payment: amount received. */
  amount?: string;
  /** Path payment only: what the sender actually parted with. */
  source_asset_type?: string;
  source_asset_code?: string | null;
  source_asset_issuer?: string | null;
  source_amount?: string;
}

/** Operation types that can settle a debt. */
export const SETTLEMENT_OPERATION_TYPES = [
  "payment",
  "path_payment_strict_receive",
  "path_payment_strict_send",
] as const;

export interface SettlementMatch {
  /** Which operation type provided the proof. */
  operationType: string;
  source: string;
  destination: string;
  /** What the recipient received — the asset the debt is denominated in. */
  receivedAsset: AssetRef;
  /** Received amount, as a decimal string. */
  receivedAmount: string;
  /** What the sender spent. Differs from the received asset on a path payment. */
  spentAsset: AssetRef | null;
  spentAmount: string | null;
  /** True when this settled through the DEX rather than as a direct transfer. */
  viaPath: boolean;
}

/** True for any operation type that can settle a debt. */
export function isSettlementOperation(op: HorizonOperationRecord): boolean {
  return SETTLEMENT_OPERATION_TYPES.includes(
    (op.type ?? "") as (typeof SETTLEMENT_OPERATION_TYPES)[number],
  );
}

/**
 * Normalises a payment or path-payment operation into one shape.
 *
 * Returns null for anything that is not a settlement-capable operation, or
 * whose fields are too incomplete to interpret.
 */
export function describeSettlementOperation(
  op: HorizonOperationRecord,
  txSourceAccount?: string,
): SettlementMatch | null {
  if (!isSettlementOperation(op)) return null;

  const source = op.from ?? op.source_account ?? txSourceAccount;
  const destination = op.to;
  if (!source || !destination || !op.amount) return null;

  let receivedAsset: AssetRef;
  try {
    receivedAsset = fromHorizonFields(op.asset_type, op.asset_code, op.asset_issuer);
  } catch {
    return null;
  }

  const viaPath = op.type !== "payment";

  let spentAsset: AssetRef | null = null;
  if (viaPath && op.source_asset_type) {
    try {
      spentAsset = fromHorizonFields(
        op.source_asset_type,
        op.source_asset_code,
        op.source_asset_issuer,
      );
    } catch {
      spentAsset = null;
    }
  }

  return {
    operationType: op.type as string,
    source,
    destination,
    receivedAsset,
    receivedAmount: op.amount,
    spentAsset,
    spentAmount: viaPath ? (op.source_amount ?? null) : op.amount,
    viaPath,
  };
}

export interface SettlementExpectation {
  source: string;
  destination: string;
  /** The asset the debt is denominated in. */
  asset: AssetRef;
  /** Exact amount owed, as a decimal string. */
  amount: string;
}

/** Compares two decimal amount strings exactly, without float rounding. */
function amountsEqual(a: string, b: string): boolean {
  const normalise = (value: string) => {
    const [whole, fraction = ""] = value.trim().split(".");
    return `${BigInt(whole || "0")}.${fraction.padEnd(7, "0").slice(0, 7)}`;
  };
  try {
    return normalise(a) === normalise(b);
  } catch {
    return false;
  }
}

/**
 * Finds the operation in `operations` that settles `expected`, if any.
 *
 * Accepts both direct payments and path payments, and in both cases asserts
 * against what the *recipient received* — never what the sender spent.
 */
export function findSettlementOperation(
  operations: HorizonOperationRecord[],
  expected: SettlementExpectation,
  txSourceAccount?: string,
): SettlementMatch | null {
  for (const op of operations) {
    const described = describeSettlementOperation(op, txSourceAccount);
    if (!described) continue;

    if (described.source !== expected.source) continue;
    if (described.destination !== expected.destination) continue;
    if (!assetEquals(described.receivedAsset, expected.asset)) continue;

    // Exact, not "at least": a strict-receive path payment delivers precisely
    // the destination amount, and a direct payment of the wrong size is not
    // this settlement.
    if (!amountsEqual(described.receivedAmount, expected.amount)) continue;

    return described;
  }

  return null;
}

/**
 * A human explanation of why no operation matched.
 *
 * Distinguishing "sent the wrong amount" from "sent the wrong asset" from "we
 * do not understand this operation type" is what makes the failure actionable
 * instead of a shrug.
 */
export function explainSettlementMismatch(
  operations: HorizonOperationRecord[],
  expected: SettlementExpectation,
  txSourceAccount?: string,
): string {
  const settlements = operations
    .map((op) => describeSettlementOperation(op, txSourceAccount))
    .filter((op): op is SettlementMatch => op !== null);

  if (settlements.length === 0) {
    return "This transaction contains no payment or path-payment operation.";
  }

  const toDestination = settlements.filter(
    (op) => op.destination === expected.destination && op.source === expected.source,
  );
  if (toDestination.length === 0) {
    return "This transaction contains no payment between the expected accounts.";
  }

  const rightAsset = toDestination.filter((op) => assetEquals(op.receivedAsset, expected.asset));
  if (rightAsset.length === 0) {
    const got = toDestination[0].receivedAsset;
    const label = isNative(got) ? "XLM" : `${got.code}`;
    return `The recipient received ${label}, but this debt is denominated in ${
      isNative(expected.asset) ? "XLM" : expected.asset.code
    }.`;
  }

  return (
    `The recipient received ${rightAsset[0].receivedAmount}, ` +
    `but ${expected.amount} is owed.`
  );
}
