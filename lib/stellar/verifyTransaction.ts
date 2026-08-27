import { HORIZON_URL, MEMO_PREFIX } from "@/lib/utils/constants";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { NATIVE_ASSET, type AssetRef } from "@/lib/stellar/assets";
import {
  explainSettlementMismatch,
  findSettlementOperation,
} from "@/lib/stellar/verifyPaymentOperation";

export interface VerifyTxParams {
  txHash: string;
  expectedSource: string;
  expectedDestination: string;
  /** The amount the recipient must receive, in the destination asset. */
  expectedAmountXlm: string;
  expectedMemo?: string;
  /** Destination asset. Defaults to native, preserving existing behaviour. */
  expectedAsset?: AssetRef;
}

export function buildExpectedPaymentMemo(memoText: string): string {
  return trimToMemoBytes(`${MEMO_PREFIX}|${memoText}`);
}

export async function verifyPaymentTransaction({
  txHash,
  expectedSource,
  expectedDestination,
  expectedAmountXlm,
  expectedMemo,
  expectedAsset,
}: VerifyTxParams): Promise<{ valid: boolean; error?: string }> {
  try {
    const txRes = await fetch(`${HORIZON_URL}/transactions/${txHash}?_ts=${Date.now()}`);
    if (!txRes.ok) {
      if (txRes.status === 404) {
        return { valid: false, error: "Transaction not found on the network." };
      }
      return { valid: false, error: `Failed to fetch transaction (HTTP ${txRes.status}).` };
    }
    
    const tx = await txRes.json();
    
    if (!tx.successful) {
      return { valid: false, error: "Transaction failed on the ledger." };
    }

    if (typeof tx.ledger !== "number" || tx.ledger <= 0) {
      return { valid: false, error: "Transaction ledger status is unavailable." };
    }

    if (expectedMemo) {
      if (tx.memo_type !== "text") {
        return { valid: false, error: "Transaction memo type does not match the expected payment memo." };
      }
      if (String(tx.memo ?? "") !== expectedMemo) {
        return { valid: false, error: "Transaction memo does not match the expected payment details." };
      }
    }

    const opsRes = await fetch(`${HORIZON_URL}/transactions/${txHash}/operations?_ts=${Date.now()}`);
    if (!opsRes.ok) {
      return { valid: false, error: `Failed to fetch transaction operations (HTTP ${opsRes.status}).` };
    }
    
    const ops = await opsRes.json();
    if (!ops._embedded || !ops._embedded.records || ops._embedded.records.length === 0) {
      return { valid: false, error: "No operations found in transaction." };
    }
    
    // Accepts a path payment as readily as a direct one, asserting on what the
    // recipient received rather than what the sender spent. The previous check
    // required `op.type === "payment"`, which silently rejected every
    // settlement made through the DEX.
    const matchingOp = findSettlementOperation(
      ops._embedded.records,
      {
        source: expectedSource,
        destination: expectedDestination,
        asset: expectedAsset ?? NATIVE_ASSET,
        amount: expectedAmountXlm,
      },
      tx.source_account,
    );

    if (!matchingOp) {
      return {
        valid: false,
        error: explainSettlementMismatch(
          ops._embedded.records,
          {
            source: expectedSource,
            destination: expectedDestination,
            asset: expectedAsset ?? NATIVE_ASSET,
            amount: expectedAmountXlm,
          },
          tx.source_account,
        ),
      };
    }

    return { valid: true };
  } catch (error: any) {
    return { valid: false, error: error.message || "Network error verifying transaction." };
  }
}
