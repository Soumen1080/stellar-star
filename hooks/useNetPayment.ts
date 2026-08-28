"use client";

import { useCallback, useState, useEffect } from "react";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import {
  recordNetSettlementOnChain,
  precheckPoolBalance,
  getPoolBalanceStroops,
  depositPoolBalance,
  stroopsToXlm,
} from "@/lib/stellar/contract";
import { fetchAttestationsForDebts } from "@/lib/settlement/settleOnChain";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { NETWORK_PASSPHRASE, STELLAR_EXPLORER, CONTRACT_ID } from "@/lib/utils/constants";
import {
  savePendingNetSettlement,
  loadPendingNetSettlement,
  clearPendingNetSettlement,
  type PendingNetSettlementRecord,
} from "@/lib/utils/pendingOnChain";
import {
  acquireSettlementIntent,
  markIntentSubmitted,
  markIntentRecorded,
  markIntentFailed,
  type SettlementIntent,
} from "@/lib/settlement/intent";
import { reconcilePendingIntentsForWallet } from "@/lib/settlement/reconcile";

type OnChainStep = "simulating" | "signing" | "sending" | "confirming";

export type PaymentState =
  | { status: "idle" }
  | { status: "building" }
  | { status: "blocked"; message: string }
  | { status: "signing" }
  | { status: "submitting" }
  | { status: "recording"; step: OnChainStep }
  | { status: "success"; hash: string; ledger: number; onChain: boolean }
  | { status: "partial_success"; hash: string; ledger: number; onChain: boolean; message: string }
  | { status: "error"; message: string };

interface UseNetPaymentOpts {
  tripId: string;
}

export interface RawDebt {
  expenseId: string;
  fromId: string;
  toId: string;
  from: string;
  to: string;
  amount: number;
  fromWallet?: string;
  toWallet?: string;
}

interface PayNetParams {
  debts: RawDebt[];
  totalAmountXlm: string;
  payerWalletAddress: string;
  tripName: string;
}

export function useNetPayment({ tripId }: UseNetPaymentOpts) {
  const { publicKey, refreshBalance } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();

  const [paymentState, setPaymentState] = useState<PaymentState>({ status: "idle" });
  const [pendingNetSettlement, setPendingNetSettlementState] = useState<PendingNetSettlementRecord | null>(null);
  const [poolBalance, setPoolBalance] = useState<string | null>(null);
  const [depositLoading, setDepositLoading] = useState(false);

  const persistPending = useCallback(
    (record: PendingNetSettlementRecord) => {
      if (publicKey) savePendingNetSettlement(publicKey, record);
      setPendingNetSettlementState(record);
    },
    [publicKey],
  );

  const clearPersistedPending = useCallback(
    (payerPublicKey: string) => {
      if (publicKey) clearPendingNetSettlement(publicKey, tripId, payerPublicKey);
      setPendingNetSettlementState(null);
    },
    [publicKey, tripId],
  );

  const buildAndPersistPending = useCallback(
    (
      txHash: string,
      ledger: number,
      payerPublicKey: string,
      totalAmountXlm: string,
      debts: { expenseId: string; amountXlm: string }[],
      memoText: string,
    ) => {
      if (!publicKey) return;
      const record: PendingNetSettlementRecord = {
        memberPublicKey: publicKey,
        tripId,
        payerPublicKey,
        totalAmountXlm,
        memoText,
        txHash,
        ledger,
        debts,
      };
      persistPending(record);
    },
    [publicKey, tripId, persistPending],
  );

  const loadPendingForPayer = useCallback((payerPublicKey: string) => {
    if (!publicKey) return;
    const restored = loadPendingNetSettlement(publicKey, tripId, payerPublicKey);
    if (restored) {
      setPendingNetSettlementState(restored);
      setPaymentState({
        status: "partial_success",
        hash: restored.txHash,
        ledger: restored.ledger,
        onChain: false,
        message: "A previous on-chain recording attempt failed. Click Retry to complete it.",
      });
    }
  }, [publicKey, tripId]);

  useEffect(() => {
    if (!publicKey) return;
    reconcilePendingIntentsForWallet(publicKey).catch(() => {});
  }, [publicKey]);

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

  const reset = useCallback((payerPublicKey: string) => {
    setPaymentState({ status: "idle" });
    clearPersistedPending(payerPublicKey);
  }, [clearPersistedPending]);

  const retryOnChainRecord = useCallback(async () => {
    if (!pendingNetSettlement) return;

    const poolCheck = await precheckPoolBalance(
      pendingNetSettlement.memberPublicKey,
      pendingNetSettlement.memberPublicKey,
      pendingNetSettlement.totalAmountXlm,
    );
    if (!poolCheck.ok) {
      const msg = poolCheck.error ?? "Pool balance precheck failed.";
      setPaymentState({
        status: "partial_success",
        hash: pendingNetSettlement.txHash,
        ledger: pendingNetSettlement.ledger,
        onChain: false,
        message: msg,
      });
      toastError("On-chain retry blocked", msg);
      return;
    }

    setPaymentState({ status: "recording", step: "simulating" });

    const attested = await fetchAttestationsForDebts(
      {
        tripId: pendingNetSettlement.tripId,
        payerPublicKey: pendingNetSettlement.payerPublicKey,
        memberPublicKey: pendingNetSettlement.memberPublicKey,
        txHash: pendingNetSettlement.txHash,
      },
      pendingNetSettlement.debts,
    );

    if (!attested.ok) {
      setPaymentState({
        status: "partial_success",
        hash: pendingNetSettlement.txHash,
        ledger: pendingNetSettlement.ledger,
        onChain: false,
        message: attested.message,
      });
      toastError(
        attested.retryable ? "On-chain proof unavailable" : "On-chain retry blocked",
        attested.message,
      );
      return;
    }

    const contractResult = await recordNetSettlementOnChain({
      ...pendingNetSettlement,
      debts: pendingNetSettlement.debts.map((debt, index) => ({
        ...debt,
        attestation: attested.attestations[index],
      })),
      onStatus: (step) => setPaymentState({ status: "recording", step }),
    });

    if (!contractResult.success) {
      const msg = contractResult.error ?? "On-chain retry failed.";
      setPaymentState({
        status: "partial_success",
        hash: pendingNetSettlement.txHash,
        ledger: pendingNetSettlement.ledger,
        onChain: false,
        message: msg,
      });
      toastError("On-chain retry failed", msg);
      return;
    }

    clearPersistedPending(pendingNetSettlement.payerPublicKey);
    setPaymentState({
      status: "success",
      hash: pendingNetSettlement.txHash,
      ledger: contractResult.ledger ?? pendingNetSettlement.ledger,
      onChain: true,
    });
    toastSuccess("On-chain record recovered", "Net settlement is now confirmed in the contract.");
    loadPoolBalance();
  }, [pendingNetSettlement, toastError, toastSuccess, loadPoolBalance, clearPersistedPending]);

  const payNetSettlement = useCallback(
    async ({ debts, totalAmountXlm, payerWalletAddress, tripName }: PayNetParams) => {
      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Freighter wallet first.");
        return;
      }
      if (!payerWalletAddress) {
        toastError("No wallet address", "The recipient doesn't have a Stellar address.");
        return;
      }

      // Pre-flight: Acquire durable settlement intents for all debts
      const acquiredIntents: SettlementIntent[] = [];
      for (const debt of debts) {
        try {
          const res = await acquireSettlementIntent({
            tripId,
            expenseId: debt.expenseId,
            memberId: debt.fromId,
            payerWallet: payerWalletAddress,
            memberWallet: publicKey,
            amount: debt.amount.toString(),
          });
          if (res.ok) {
            acquiredIntents.push(res.intent);
          } else if (res.code === "IN_PROGRESS") {
            setPaymentState({ status: "blocked", message: res.message });
            toastError("Settlement in progress", res.message);
            return;
          }
        } catch {
          // non-fatal
        }
      }

      try {
        if (CONTRACT_ID && tripId) {
          const poolCheck = await precheckPoolBalance(publicKey, publicKey, totalAmountXlm);
          if (!poolCheck.ok) {
            const msg =
              poolCheck.error ?? "Add enough pool credit before sending this settlement.";
            setPaymentState({ status: "blocked", message: msg });
            toastError("Pool credit required", msg);
            await loadPoolBalance();
            for (const intent of acquiredIntents) {
              markIntentFailed(intent.id, msg).catch(() => {});
            }
            return;
          }
        }

        setPaymentState({ status: "building" });
        const memoText = tripName;
        const { xdr } = await buildPaymentTransaction({
          sourcePublicKey:      publicKey,
          destinationPublicKey: payerWalletAddress,
          amount:               totalAmountXlm,
          memoText,
        });

        setPaymentState({ status: "signing" });
        toastInfo("Waiting for wallet signature...", "Review and confirm the net settlement.");
        const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE);

        setPaymentState({ status: "submitting" });
        const result = await submitSignedTransaction(signedXDR);

        for (const intent of acquiredIntents) {
          markIntentSubmitted(intent.id, result.hash, result.ledger).catch(() => {});
        }

        let onChain = false;
        let onChainError: string | null = null;
        
        const mappedDebts = debts.map(d => ({ expenseId: d.expenseId, amountXlm: d.amount.toString() }));

        if (CONTRACT_ID && tripId) {
          setPaymentState({ status: "recording", step: "simulating" });

          // One attestation per debt: the contract records each expense
          // separately, so each needs its own single-use proof. The oracle's
          // allocation ledger keeps their total within what was actually paid.
          const attested = await fetchAttestationsForDebts(
            {
              tripId,
              payerPublicKey: payerWalletAddress,
              memberPublicKey: publicKey,
              txHash: result.hash,
            },
            mappedDebts,
          );

          if (!attested.ok) {
            onChainError = attested.message;
            buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, totalAmountXlm, mappedDebts, memoText);
          } else {
            const contractResult = await recordNetSettlementOnChain({
              memberPublicKey: publicKey,
              tripId,
              payerPublicKey: payerWalletAddress,
              txHash: result.hash,
              debts: mappedDebts.map((debt, index) => ({
                ...debt,
                attestation: attested.attestations[index],
              })),
              onStatus: (step) => setPaymentState({ status: "recording", step }),
            });

            if (contractResult.success) {
              onChain = true;
              loadPoolBalance();
            } else {
              onChainError = contractResult.error ?? "On-chain recording failed.";
              buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, totalAmountXlm, mappedDebts, memoText);
            }
          }
        }

        // Always sync local state after successful XLM transfer
        for (const debt of debts) {
          try {
            await markSharePaid(debt.expenseId, debt.fromId, result.hash);
          } catch {
            // non-fatal
          }
        }

        for (const intent of acquiredIntents) {
          markIntentRecorded(intent.id, result.ledger, onChain).catch(() => {});
        }

        if (onChainError) {
          setPaymentState({
            status: "partial_success",
            hash: result.hash,
            ledger: result.ledger,
            onChain: false,
            message: onChainError,
          });
          toastInfo(
            "Payment sent — recorded off-chain only",
            "The XLM transfer succeeded, but this settlement has no on-chain proof yet. Use retry to add it.",
          );
          setTimeout(() => refreshBalance(), 3000);
          setTimeout(() => refreshBalance(), 8000);
          return;
        }

        setPaymentState({ status: "success", hash: result.hash, ledger: result.ledger, onChain });
        toastSuccess(
          `Settlement sent!`,
          onChain
            ? `Paid ${parseFloat(totalAmountXlm).toFixed(4)} XLM. TX: ${result.hash.slice(0, 12)}... · Recorded on-chain`
            : `Paid ${parseFloat(totalAmountXlm).toFixed(4)} XLM. TX: ${result.hash.slice(0, 12)}...`,
        );

        setTimeout(() => refreshBalance(), 3000);
        setTimeout(() => refreshBalance(), 8000);
      } catch (err) {
        const message    = err instanceof Error ? err.message : "Payment failed. Please try again.";
        const isRejected = /reject|denied|cancel/i.test(message.toLowerCase());
        const display    = isRejected ? "Transaction cancelled in wallet." : message;

        for (const intent of acquiredIntents) {
          markIntentFailed(intent.id, display).catch(() => {});
        }

        setPaymentState({ status: "error", message: display });
        toastError("Payment failed", display);
      }
    },
    [
      publicKey,
      tripId,
      markSharePaid,
      refreshBalance,
      toastSuccess,
      toastError,
      toastInfo,
      loadPoolBalance,
      buildAndPersistPending,
    ],
  );

  return {
    paymentState,
    payNetSettlement,
    reset,
    retryOnChainRecord,
    loadPendingForPayer,
    poolBalance,
    depositLoading,
    depositPool,
    loadPoolBalance,
    hasPendingRetry: pendingNetSettlement !== null,
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
