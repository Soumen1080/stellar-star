"use client";

import { useCallback, useState } from "react";
import { type AssetRef } from "@/lib/stellar/assets";
import { signXDR } from "@/lib/freighter";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  buildChangeTrustTransaction,
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

  const addTrustline = useCallback(
    async (publicKey: string) => {
      setPhase("preparing");
      setError(null);
      setTxHash(null);
      setInsufficientReserve(false);

      try {
        // buildChangeTrustTransaction verifies affordability against live
        // ledger state and refuses native XLM, so an impossible attempt fails
        // here — before the wallet ever prompts for a signature.
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
