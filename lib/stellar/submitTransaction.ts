import { TransactionBuilder } from "@stellar/stellar-sdk";
import { createHorizonServer, server } from "./client";
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
    op_malformed:            "Transaction is malformed - check the amount and addresses.",
  };
  return map[code] ?? `Operation failed: ${code}`;
}

/**
 * Translates a Horizon rejection into an actionable message.
 *
 * A transaction is only ever submitted once, so this runs per attempt rather
 * than per caller — every caller sharing that attempt shares its error too.
 */
async function submitToHorizon(
  signedXDR: string,
  requestId?: string,
): Promise<StellarSubmitResult> {
  try {
    const tx = TransactionBuilder.fromXDR(signedXDR, NETWORK_PASSPHRASE);
    const horizon = requestId ? createHorizonServer(requestId) : server;
    const response = await horizon.submitTransaction(tx);
    return { hash: response.hash, ledger: response.ledger, successful: true };
  } catch (err: unknown) {
    const horizonErr = err as { response?: { data?: HorizonErrorResponse } };
    const extras = horizonErr?.response?.data?.extras;

    if (extras?.result_codes) {
      const { transaction, operations } = extras.result_codes;

      const failedOpCode = operations?.find(code => code !== "op_success");
      if (failedOpCode) throw new Error(friendlyOpError(failedOpCode));
      
      if (transaction === "tx_bad_seq")          throw new Error("Transaction sequence mismatch. Please try again.");
      if (transaction === "tx_insufficient_fee") throw new Error("Transaction fee too low. Please try again.");
      if (transaction !== "tx_success")          throw new Error(`Transaction failed: ${transaction}`);
    }

    throw err instanceof Error ? err : new Error("Transaction submission failed.");
  }
}

/**
 * How long a successful submission stays de-duplicated.
 *
 * A signed XDR is a one-shot instruction: once Horizon has accepted it, the
 * source account sequence number it spends is consumed, and re-submitting can
 * only ever return that same transaction. The window therefore only has to
 * outlast the retries that matter — a double-tapped button, a retry after a
 * dropped response, a tab resumed inside the same interaction.
 */
const SUBMIT_DEDUP_TTL_MS = 30_000;

/**
 * Upper bound on retained success entries.
 *
 * Entries are keyed by full signed XDR, so a long-lived tab paying many expenses
 * would otherwise hold every XDR it ever sent. The cap is far above any real
 * burst of payments within one TTL window.
 */
const SUBMIT_DEDUP_MAX_ENTRIES = 64;

/** In-flight submissions keyed by signed XDR, so one XDR means one Horizon POST. */
const inflightSubmits = new Map<string, Promise<StellarSubmitResult>>();

/** Recently successful submissions keyed by signed XDR. */
const settledSubmits = new Map<string, { result: StellarSubmitResult; expiresAt: number }>();

/**
 * Clears the submission de-duplication caches.
 *
 * Exposed for tests. At runtime the caches are process-local and self-expiring,
 * so there is nothing to flush between submissions.
 */
export function clearSignedSubmitCache(): void {
  inflightSubmits.clear();
  settledSubmits.clear();
}

/**
 * Submits an already-signed transaction, de-duplicating by signed XDR.
 *
 * A signed XDR fully identifies one payment, which makes it its own idempotency
 * key:
 *
 *  - Concurrent callers share a single in-flight submission instead of racing
 *    two identical POSTs at Horizon.
 *  - A retry landing shortly after a *successful* submission is answered from
 *    the short-lived success cache rather than re-sent.
 *  - Failures are never cached, so a retry after a genuine rejection still
 *    re-submits and the payer can recover.
 *
 * This de-duplicates the Horizon leg only. The steps that follow it — the
 * attestation fetch and `recordPaymentOnChain`, which builds a *new* Soroban
 * transaction that the contract would happily accept twice — are guarded by the
 * caller's single-flight registration in `lib/settlement/inflight`.
 */
export function submitSignedTransaction(
  signedXDR: string,
  requestId?: string,
): Promise<StellarSubmitResult> {
  const key = signedXDR.trim();

  const settled = settledSubmits.get(key);
  if (settled) {
    settledSubmits.delete(key);
    if (settled.expiresAt > Date.now()) return Promise.resolve(settled.result);
  }

  const inflight = inflightSubmits.get(key);
  if (inflight) return inflight;

  const attempt = submitToHorizon(signedXDR, requestId)
    .then((result) => {
      settledSubmits.set(key, { result, expiresAt: Date.now() + SUBMIT_DEDUP_TTL_MS });
      // Map iteration is insertion-ordered, so the first key is the oldest entry.
      while (settledSubmits.size > SUBMIT_DEDUP_MAX_ENTRIES) {
        const oldest = settledSubmits.keys().next().value;
        if (oldest === undefined) break;
        settledSubmits.delete(oldest);
      }
      return result;
    })
    .finally(() => {
      if (inflightSubmits.get(key) === attempt) inflightSubmits.delete(key);
    });

  inflightSubmits.set(key, attempt);
  return attempt;
}
