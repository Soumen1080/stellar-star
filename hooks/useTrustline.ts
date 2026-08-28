"use client";

import { useCallback, useState } from "react";
import { type AssetRef } from "@/lib/stellar/assets";
import { signXDR } from "@/lib/freighter";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { buildChangeTrustTransaction } from "@/lib/stellar/trustline";
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

  const addTrustline = useCallback(
    async (publicKey: string) => {
      setPhase("preparing");
      setError(null);
      setTxHash(null);

      try {
        const { xdr } = await buildChangeTrustTransaction({
          publicKey,
          asset,
        });

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
        setPhase("error");
        setError(rejected ? "You cancelled the wallet signature." : message);
        return false;
      }
    },
    [asset],
  );

  const reset = useCallback(() => {
    setPhase("idle");
    setError(null);
    setTxHash(null);
  }, []);

  return { phase, error, txHash, addTrustline, reset };
}
