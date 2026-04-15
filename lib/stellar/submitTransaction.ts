import { TransactionBuilder } from "@stellar/stellar-sdk";
import { server } from "./client";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import type { StellarSubmitResult, HorizonErrorResponse } from "@/types/stellar";

export type { StellarSubmitResult };

function friendlyOpError(code: string): string {
  const map: Record<string, string> = {
    op_underfunded:          "Insufficient XLM balance to complete this payment.",
    op_insufficient_balance: "Insufficient XLM balance to complete this payment.",
    op_no_destination:       "The recipient account doesn't exist on the Stellar network.",
    op_no_trust:             "The recipient hasn't set up a trustline for this asset.",
    op_line_full:            "The recipient's account cannot receive more of this asset.",
    op_not_authorized:       "You are not authorised to send to this account.",
    op_malformed:            "Transaction is malformed — check the amount and addresses.",
  };
  return map[code] ?? `Operation failed: ${code}`;
}

export async function submitSignedTransaction(signedXDR: string): Promise<StellarSubmitResult> {
  try {
    const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
    const response = await server.submitTransaction(tx);
    return { hash: response.hash, ledger: response.ledger, successful: true };
  } catch (err: unknown) {
    const horizonErr = err as { response?: { data?: HorizonErrorResponse } };
    const extras = horizonErr?.response?.data?.extras;

    if (extras?.result_codes) {
      const { transaction, operations } = extras.result_codes;
      const opCode = operations?.[0];
      if (opCode && opCode !== "op_success") throw new Error(friendlyOpError(opCode));
      if (transaction === "tx_bad_seq")          throw new Error("Transaction sequence mismatch. Please try again.");
      if (transaction === "tx_insufficient_fee") throw new Error("Transaction fee too low. Please try again.");
      if (transaction !== "tx_success")          throw new Error(`Transaction failed: ${transaction}`);
    }

    throw err instanceof Error ? err : new Error("Transaction submission failed.");
  }
}
