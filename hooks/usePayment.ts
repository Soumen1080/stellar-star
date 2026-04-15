"use client";

import { useCallback, useState } from "react";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { recordPaymentOnChain, checkIsPaid, precheckPoolBalance } from "@/lib/stellar/contract";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { NETWORK_PASSPHRASE, STELLAR_EXPLORER, CONTRACT_ID } from "@/lib/utils/constants";
import type { SplitShare } from "@/types/expense";

type OnChainStep = "simulating" | "signing" | "sending" | "confirming";

export type PaymentState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "recording"; step: OnChainStep }
  | { status: "success"; hash: string; ledger: number; onChain: boolean }
  | { status: "partial_success"; hash: string; ledger: number; onChain: boolean; message: string }
  | { status: "error"; message: string };

interface UsePaymentOpts {
  expenseId: string;
}

interface PayShareParams {
  share: SplitShare;
  expenseTitle: string;
  payerWalletAddress: string;
  tripId?: string;
}

interface PendingOnChainRecord {
  memberPublicKey: string;
  tripId: string;
  expenseId: string;
  payerPublicKey: string;
  amountXlm: string;
  txHash: string;
  ledger: number;
}

export function usePayment({ expenseId }: UsePaymentOpts) {
  const { publicKey, refreshBalance } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();

  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  const [pendingOnChain, setPendingOnChain] = useState<PendingOnChainRecord | null>(null);

  const reset = useCallback(() => {
    setPaymentState({ status: "idle" });
    setPendingOnChain(null);
  }, []);

  const retryOnChainRecord = useCallback(async () => {
    if (!pendingOnChain) return;

    const poolCheck = await precheckPoolBalance(
      pendingOnChain.memberPublicKey,
      pendingOnChain.memberPublicKey,
      pendingOnChain.amountXlm,
    );
    if (!poolCheck.ok) {
      const msg = poolCheck.error ?? "Pool balance precheck failed.";
      setPaymentState({
        status: "partial_success",
        hash: pendingOnChain.txHash,
        ledger: pendingOnChain.ledger,
        onChain: false,
        message: msg,
      });
      toastError("On-chain retry blocked", msg);
      return;
    }

    const contractResult = await recordPaymentOnChain({
      ...pendingOnChain,
      onStatus: (step) => setPaymentState({ status: "recording", step }),
    });

    if (!contractResult.success) {
      const msg = contractResult.error ?? "On-chain retry failed.";
      setPaymentState({
        status: "partial_success",
        hash: pendingOnChain.txHash,
        ledger: pendingOnChain.ledger,
        onChain: false,
        message: msg,
      });
      toastError("On-chain retry failed", msg);
      return;
    }

    setPendingOnChain(null);
    setPaymentState({
      status: "success",
      hash: pendingOnChain.txHash,
      ledger: contractResult.ledger ?? pendingOnChain.ledger,
      onChain: true,
    });
    toastSuccess("On-chain record recovered", "Payment is now confirmed in the contract.");
  }, [pendingOnChain, toastError, toastSuccess]);

  const payShare = useCallback(
    async ({ share, expenseTitle, payerWalletAddress, tripId }: PayShareParams) => {
      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Freighter wallet first.");
        return;
      }
      if (!share.walletAddress) {
        toastError("No wallet address", `${share.name} doesn't have a Stellar address.`);
        return;
      }
      if (!payerWalletAddress) {
        toastError("Payer has no wallet", "The expense creator hasn't added their Stellar address.");
        return;
      }

      // Pre-flight: check if already settled on-chain before building the TX
      if (CONTRACT_ID && share.walletAddress) {
        const alreadyPaid = await checkIsPaid(publicKey, expenseId, share.walletAddress);
        if (alreadyPaid.paid) {
          toastError(
            "Already settled on-chain",
            "This payment was already recorded on Stellar. No action needed.",
          );
          return;
        }
      }

      try {
        setPaymentState({ status: "building" });
        const memoText = `${expenseTitle}|${share.name}`.slice(0, 24);
        const { xdr } = await buildPaymentTransaction({
          sourcePublicKey:      publicKey,
          destinationPublicKey: payerWalletAddress,
          amount:               share.amount,
          memoText,
        });

        setPaymentState({ status: "signing" });
        toastInfo("Waiting for wallet signature…", "Review and confirm the transaction.");
        const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE);

        setPaymentState({ status: "submitting" });
        const result = await submitSignedTransaction(signedXDR);

        let onChain = false;
        let onChainError: string | null = null;
        if (CONTRACT_ID && tripId) {
          const poolCheck = await precheckPoolBalance(publicKey, publicKey, share.amount);
          if (!poolCheck.ok) {
            onChainError =
              poolCheck.error ??
              "Pool balance is too low to record this payment on-chain.";
            setPendingOnChain({
              memberPublicKey: publicKey,
              tripId,
              expenseId,
              payerPublicKey: payerWalletAddress,
              amountXlm: share.amount,
              txHash: result.hash,
              ledger: result.ledger,
            });
          } else {
          setPaymentState({ status: "recording", step: "simulating" });
          const contractResult = await recordPaymentOnChain({
            memberPublicKey: publicKey,
            tripId,
            expenseId,
            payerPublicKey: payerWalletAddress,
            amountXlm:      share.amount,
            txHash:         result.hash,
            onStatus:       (step) => setPaymentState({ status: "recording", step }),
          });

          if (contractResult.success) {
            onChain = true;
          } else {
            onChainError = contractResult.error ?? "On-chain recording failed.";
            setPendingOnChain({
              memberPublicKey: publicKey,
              tripId,
              expenseId,
              payerPublicKey: payerWalletAddress,
              amountXlm: share.amount,
              txHash: result.hash,
              ledger: result.ledger,
            });
          }
          }
        }

        // Always sync local state after successful XLM transfer so UI reflects financial reality.
        await markSharePaid(expenseId, share.memberId, result.hash);

        if (onChainError) {
          setPaymentState({
            status: "partial_success",
            hash: result.hash,
            ledger: result.ledger,
            onChain: false,
            message: onChainError,
          });
          toastInfo(
            "Payment sent, on-chain record pending",
            "XLM transfer succeeded. Use retry after fixing contract prerequisites (e.g. pool balance).",
          );
          setTimeout(() => refreshBalance(), 3000);
          setTimeout(() => refreshBalance(), 8000);
          return;
        }

        setPaymentState({ status: "success", hash: result.hash, ledger: result.ledger, onChain });
        toastSuccess(
          `Paid ${parseFloat(share.amount).toFixed(4)} XLM to ${share.name}`,
          onChain
            ? `TX: ${result.hash.slice(0, 12)}… · Recorded on-chain ✓`
            : `TX: ${result.hash.slice(0, 12)}…`,
        );

        setTimeout(() => refreshBalance(), 3000);
        setTimeout(() => refreshBalance(), 8000);
      } catch (err) {
        const message    = err instanceof Error ? err.message : "Payment failed. Please try again.";
        const isRejected = /reject|denied|cancel/i.test(message.toLowerCase());
        const display    = isRejected ? "Transaction cancelled in wallet." : message;

        setPaymentState({ status: "error", message: display });
        toastError("Payment failed", display);
      }
    },
    [publicKey, expenseId, markSharePaid, refreshBalance, toastSuccess, toastError, toastInfo],
  );

  return {
    paymentState,
    payShare,
    reset,
    retryOnChainRecord,
    isIdle:    paymentState.status === "idle",
    isLoading: ["building", "signing", "submitting", "recording"].includes(paymentState.status),
    isSuccess: paymentState.status === "success",
    isError:   paymentState.status === "error",
    txHash:    paymentState.status === "success" || paymentState.status === "partial_success" ? paymentState.hash : null,
    onChain:   paymentState.status === "success" || paymentState.status === "partial_success" ? paymentState.onChain : false,
    explorerUrl: paymentState.status === "success" || paymentState.status === "partial_success"
      ? `${STELLAR_EXPLORER}/tx/${paymentState.hash}`
      : null,
  };
}

