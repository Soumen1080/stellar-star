import { TransactionBuilder, Horizon } from "@stellar/stellar-sdk";
import { createHorizonServer, server } from "./client";
import { NETWORK_PASSPHRASE, HORIZON_URL } from "@/lib/utils/constants";
import { REQUEST_ID_HEADER } from "@/lib/observability/requestId";
import type { StellarSubmitResult, HorizonErrorResponse } from "@/types/stellar";
import { reportError } from "@/lib/observability/reportError";
import { executeWithFailover, DuplicatePaymentPreventedError } from "@/lib/routing";

export type { StellarSubmitResult };

function friendlyOpError(code: string): string {
  const map: Record<string, string> = {
    op_underfunded:          "Insufficient XLM balance to complete this payment.",
    op_insufficient_balance: "Insufficient XLM balance to complete this payment.",
    op_no_destination:       "The recipient account doesn't exist on the Stellar network.",
    op_no_trust:             "The recipient hasn't set up a trustline for this asset.",
    op_line_full:            "The recipient's account cannot receive more of this asset.",
    op_not_authorized:       "You are not authorised to send to this account.",
    op_malformed:            "Transaction is malformed - check the amount and addresses.",
  };
  return map[code] ?? `Operation failed: ${code}`;
}

export async function submitSignedTransaction(
  signedXDR: string,
  requestId?: string,
): Promise<StellarSubmitResult> {
  const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
  const txHash = typeof (tx as any).hash === "function"
    ? (tx as any).hash().toString("hex")
    : String((tx as any).id || "mock-tx-hash");

  try {
    return await executeWithFailover<StellarSubmitResult>(
      {
        domain: "stellar",
        capability: "stellar:submit",
        requireSubmissionConsistency: true,
        txHash,
        verifyTxExists: async (hash: string) => {
          try {
            const res = await fetch(`${HORIZON_URL}/transactions/${hash}`, { cache: "no-store" });
            return res.ok;
          } catch {
            return false;
          }
        },
      },
      async (provider) => {
        const horizon = provider.endpointUrl && provider.endpointUrl !== HORIZON_URL
          ? new Horizon.Server(provider.endpointUrl, {
              allowHttp: provider.endpointUrl.startsWith("http://"),
              ...(requestId ? { headers: { [REQUEST_ID_HEADER]: requestId } } : {}),
            })
          : (requestId ? createHorizonServer(requestId) : server);

        try {
          const response = await horizon.submitTransaction(tx as any);
          return { hash: response.hash, ledger: response.ledger, successful: true };
        } catch (err: unknown) {
          const horizonErr = err as { response?: { data?: HorizonErrorResponse } };
          const extras = horizonErr?.response?.data?.extras;

          reportError(
            "payment.submission-failed",
            err,
            {
              operation: "submitSignedTransaction",
              providerId: provider.id,
              resultCodes: extras?.result_codes,
            },
            "error",
            requestId,
          );

          if (extras?.result_codes) {
            const { transaction, operations } = extras.result_codes;
            const failedOp = operations?.find((op) => op !== "op_success");
            if (failedOp) throw new Error(friendlyOpError(failedOp));
            if (transaction === "tx_bad_seq")          throw new Error("Transaction sequence mismatch. Please try again.");
            if (transaction === "tx_insufficient_fee") throw new Error("Transaction fee too low. Please try again.");
            if (transaction !== "tx_success")          throw new Error(`Transaction failed: ${transaction}`);
          }

          throw err instanceof Error ? err : new Error("Transaction submission failed.");
        }
      },
    );
  } catch (err: unknown) {
    if (err instanceof DuplicatePaymentPreventedError) {
      return { hash: txHash, ledger: 0, successful: true };
    }
    throw err;
  }
}
