"use client";

import { useCallback, useState, useEffect } from "react";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  recordPaymentOnChain,
  checkIsPaid,
  precheckPoolBalance,
  getPoolBalanceStroops,
  depositPoolBalance,
  stroopsToXlm,
} from "@/lib/stellar/contract";
import { verifyPaymentTransaction } from "@/lib/stellar/verifyTransaction";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { NETWORK_PASSPHRASE, STELLAR_EXPLORER, CONTRACT_ID } from "@/lib/utils/constants";
import {
  savePendingOnChain,
  loadPendingOnChain,
  clearPendingOnChain,
  type PendingOnChainRecord,
} from "@/lib/utils/pendingOnChain";
import type { SplitShare } from "@/types/expense";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// Re-export so consumers can import the type from the hook module directly.
export type { PendingOnChainRecord };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePayment({ expenseId }: UsePaymentOpts) {
  const { publicKey, refreshBalance } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();

  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  const [pendingOnChain, setPendingOnChainState] = useState<PendingOnChainRecord | null>(null);
  const [poolBalance, setPoolBalance] = useState<string | null>(null);
  const [depositLoading, setDepositLoading] = useState(false);

  // ---------------------------------------------------------------------------
  // Persistence helpers — keep localStorage in sync with React state
  // ---------------------------------------------------------------------------

  /** Write to localStorage then update state. */
  const persistPendingOnChain = useCallback(
    (record: PendingOnChainRecord) => {
      if (publicKey) savePendingOnChain(publicKey, record);
      setPendingOnChainState(record);
    },
    [publicKey],
  );

  /** Wipe from localStorage then clear state. */
  const clearPersistedPendingOnChain = useCallback(() => {
    if (publicKey) clearPendingOnChain(publicKey, expenseId);
    setPendingOnChainState(null);
  }, [publicKey, expenseId]);

  /**
   * Build a PendingOnChainRecord from payShare arguments and persist it.
   * Stable callback — placed at hook level so it is not recreated inside payShare.
   */
  const buildAndPersistPending = useCallback(
    (
      txHash: string,
      ledger: number,
      payerWalletAddress: string,
      amountXlm: string,
      tripId: string,
    ) => {
      if (!publicKey) return;
      const record: PendingOnChainRecord = {
        memberPublicKey: publicKey,
        tripId,
        expenseId,
        payerPublicKey: payerWalletAddress,
        amountXlm,
        txHash,
        ledger,
      };
      persistPendingOnChain(record);
    },
    [publicKey, expenseId, persistPendingOnChain],
  );

  // ---------------------------------------------------------------------------
  // On mount — restore any persisted pending retry from localStorage
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!publicKey) return;
    const restored = loadPendingOnChain(publicKey, expenseId);
    if (restored) {
      setPendingOnChainState(restored);
      setPaymentState({
        status: "partial_success",
        hash: restored.txHash,
        ledger: restored.ledger,
        onChain: false,
        message: "A previous on-chain recording attempt failed. Click Retry to complete it.",
      });
    }
    // Only run once per (publicKey, expenseId) combination — intentional deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [publicKey, expenseId]);

  // ---------------------------------------------------------------------------
  // Pool balance
  // ---------------------------------------------------------------------------

  const loadPoolBalance = useCallback(async () => {
    if (!publicKey) {
      setPoolBalance(null);
      return;
    }
    try {
      const balanceStroops = await getPoolBalanceStroops(publicKey, publicKey);
      setPoolBalance(stroopsToXlm(balanceStroops));
    } catch (err) {
      console.error("Failed to load pool balance:", err);
      setPoolBalance(null);
    }
  }, [publicKey]);

  useEffect(() => {
    loadPoolBalance();
  }, [loadPoolBalance]);

  const depositPool = useCallback(
    async (amountXlm: string) => {
      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Freighter wallet first.");
        return false;
      }
      setDepositLoading(true);
      try {
        const result = await depositPoolBalance(publicKey, amountXlm);
        if (result.success) {
          toastSuccess(
            "Deposit successful",
            `Deposited ${parseFloat(amountXlm).toFixed(4)} XLM into pool.`,
          );
          await loadPoolBalance();
          return true;
        }
        toastError("Deposit failed", result.error ?? "Unknown error");
        return false;
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Deposit failed.";
        toastError("Deposit failed", msg);
        return false;
      } finally {
        setDepositLoading(false);
      }
    },
    [publicKey, loadPoolBalance, toastError, toastSuccess],
  );

  // ---------------------------------------------------------------------------
  // reset — also wipes the persisted record
  // ---------------------------------------------------------------------------

  const reset = useCallback(() => {
    setPaymentState({ status: "idle" });
    clearPersistedPendingOnChain();
  }, [clearPersistedPendingOnChain]);

  // ---------------------------------------------------------------------------
  // retryOnChainRecord — clears storage on success
  // ---------------------------------------------------------------------------

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

    setPaymentState({ status: "recording", step: "simulating" });
    const verifyResult = await verifyPaymentTransaction({
      txHash: pendingOnChain.txHash,
      expectedSource: pendingOnChain.memberPublicKey,
      expectedDestination: pendingOnChain.payerPublicKey,
      expectedAmountXlm: pendingOnChain.amountXlm,
    });

    if (!verifyResult.valid) {
      const msg = verifyResult.error ?? "Invalid payment transaction on network.";
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

    // Success — wipe persisted record so it doesn't reappear after refresh.
    clearPersistedPendingOnChain();
    setPaymentState({
      status: "success",
      hash: pendingOnChain.txHash,
      ledger: contractResult.ledger ?? pendingOnChain.ledger,
      onChain: true,
    });
    toastSuccess("On-chain record recovered", "Payment is now confirmed in the contract.");
    loadPoolBalance();
  }, [pendingOnChain, toastError, toastSuccess, loadPoolBalance, clearPersistedPendingOnChain]);

  // ---------------------------------------------------------------------------
  // payShare — persists pending record on partial failure
  // ---------------------------------------------------------------------------

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
        toastError(
          "Payer has no wallet",
          "The expense creator hasn't added their Stellar address.",
        );
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
        toastInfo("Waiting for wallet signature...", "Review and confirm the transaction.");
        const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE);

        setPaymentState({ status: "submitting" });
        const result = await submitSignedTransaction(signedXDR);

        let onChain = false;
        let onChainError: string | null = null;

        if (CONTRACT_ID && tripId) {
          setPaymentState({ status: "recording", step: "simulating" });

          const verifyResult = await verifyPaymentTransaction({
            txHash: result.hash,
            expectedSource: publicKey,
            expectedDestination: payerWalletAddress,
            expectedAmountXlm: share.amount,
          });

          if (!verifyResult.valid) {
            onChainError = verifyResult.error ?? "Invalid payment transaction on network.";
            buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, share.amount, tripId);
          } else {
            const poolCheck = await precheckPoolBalance(publicKey, publicKey, share.amount);
            if (!poolCheck.ok) {
              onChainError =
                poolCheck.error ?? "Pool balance is too low to record this payment on-chain.";
              buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, share.amount, tripId);
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
                loadPoolBalance();
              } else {
                onChainError = contractResult.error ?? "On-chain recording failed.";
                buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, share.amount, tripId);
              }
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
            ? `TX: ${result.hash.slice(0, 12)}... · Recorded on-chain (verified)`
            : `TX: ${result.hash.slice(0, 12)}...`,
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
    [
      publicKey,
      expenseId,
      markSharePaid,
      refreshBalance,
      toastSuccess,
      toastError,
      toastInfo,
      loadPoolBalance,
      buildAndPersistPending,
    ],
  );

  // ---------------------------------------------------------------------------
  // Return
  // ---------------------------------------------------------------------------

  return {
    paymentState,
    payShare,
    reset,
    retryOnChainRecord,
    poolBalance,
    depositLoading,
    depositPool,
    loadPoolBalance,
    /** True when a durable pending retry record exists (survives refresh). */
    hasPendingRetry: pendingOnChain !== null,
    isIdle:    paymentState.status === "idle",
    isLoading: ["building", "signing", "submitting", "recording"].includes(paymentState.status),
    isSuccess: paymentState.status === "success",
    isError:   paymentState.status === "error",
    txHash:
      paymentState.status === "success" || paymentState.status === "partial_success"
        ? paymentState.hash
        : null,
    onChain:
      paymentState.status === "success" || paymentState.status === "partial_success"
        ? paymentState.onChain
        : false,
    explorerUrl:
      paymentState.status === "success" || paymentState.status === "partial_success"
        ? `${STELLAR_EXPLORER}/tx/${paymentState.hash}`
        : null,
  };
}
