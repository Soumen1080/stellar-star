"use client";

import { useCallback, useRef, useState } from "react";
import { type AssetRef } from "@/lib/stellar/assets";
import { signXDR } from "@/lib/freighter";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  buildChangeTrustTransaction,
  hasTrustline,
  InsufficientReserveError,
} from "@/lib/stellar/trustline";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";

export type TrustlinePhase =
  | "idle"
  | "preparing"
  | "awaiting_signature"
  | "submitting"
  | "done"
  | "error";

export function useTrustline(asset: AssetRef) {
  const [phase, setPhase] = useState<TrustlinePhase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  /** Reserve the trustline locks, read from live ledger parameters. */
  const [reserveStroops, setReserveStroops] = useState<bigint | null>(null);
  /** True when the failure was "cannot afford the reserve", not a signing error. */
  const [insufficientReserve, setInsufficientReserve] = useState(false);

  /**
   * Holds the promise of an in-flight addTrustline call.
   *
   * If addTrustline is invoked a second time before the first resolves (e.g. a
   * double-click or a React strict-mode double-effect), the guard returns the
   * already-running promise instead of launching a duplicate ChangeTrust
   * transaction. The ref is cleared once the attempt settles.
   */
  const inFlightRef = useRef<Promise<boolean> | null>(null);

  const addTrustline = useCallback(
    async (publicKey: string): Promise<boolean> => {
      // Collapse concurrent calls — return the same promise, not a second attempt.
      if (inFlightRef.current) return inFlightRef.current;

      const attempt = (async (): Promise<boolean> => {
        setPhase("preparing");
        setError(null);
        setTxHash(null);
        setInsufficientReserve(false);

        try {
          // Idempotency guard: if the trustline already exists on-chain there
          // is nothing to do. This catches the most common race — the user
          // clicks the button twice and the first submission lands before the
          // second one builds its transaction.
          const alreadyExists = await hasTrustline(publicKey, asset);
          if (alreadyExists) {
            setPhase("done");
            return true;
          }

          // buildChangeTrustTransaction verifies affordability against live
          // ledger state and refuses native XLM, so an impossible attempt
          // fails here — before the wallet ever prompts for a signature.
          const { xdr, reserveStroops: locked } = await buildChangeTrustTransaction({
            publicKey,
            asset,
          });
          setReserveStroops(locked);

          setPhase("awaiting_signature");
          const signed = await signXDR(xdr, NETWORK_PASSPHRASE);

          setPhase("submitting");
          const result = await submitSignedTransaction(signed);

          setPhase("done");
          setTxHash(result.hash);
          return true;
        } catch (err) {
          const message = err instanceof Error ? err.message : "Failed to add trustline.";

          // Horizon returns op_already_exists when a ChangeTrust for a line
          // the account already holds is submitted (e.g. a duplicate that
          // slipped past the pre-flight check). Treat it as success.
          if (/op_already_exists|already_exists/i.test(message)) {
            setPhase("done");
            return true;
          }

          const rejected = /reject|denied|cancel/i.test(message);
          const unaffordable =
            err instanceof InsufficientReserveError ||
            (err instanceof Error && err.name === "InsufficientReserveError");

          setInsufficientReserve(unaffordable);
          setPhase("error");
          // The reserve message already explains the shortfall in XLM; do not
          // overwrite it with the generic cancellation copy.
          setError(rejected && !unaffordable ? "You cancelled the wallet signature." : message);
          return false;
        }
      })();

      inFlightRef.current = attempt;
      try {
        return await attempt;
      } finally {
        inFlightRef.current = null;
      }
    },
    [asset],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setTxHash(null);
    setInsufficientReserve(false);
  }, []);

  return {
    phase,
    error,
    txHash,
    reserveStroops,
    insufficientReserve,
    addTrustline,
    reset,
  };
}
