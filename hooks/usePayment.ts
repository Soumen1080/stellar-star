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
import { fetchAttestation } from "@/lib/settlement/settleOnChain";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useLocale } from "@/context/LocaleContext";
import { formatMoney } from "@/lib/money/format";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import {
  NETWORK_PASSPHRASE,
  STELLAR_EXPLORER,
  CONTRACT_ID,
  STELLAR_NETWORK,
  getNetworkConfigErrors,
} from "@/lib/utils/constants";
import { reportError } from "@/lib/observability/reportError";
import { createRequestId } from "@/lib/observability/requestId";
import { networkMismatchMessage } from "@/lib/stellar/networkMismatch";
import {
  savePendingOnChain,
  loadPendingOnChain,
  clearPendingOnChain,
  type PendingOnChainRecord,
} from "@/lib/utils/pendingOnChain";
import {
  acquireSettlementIntent,
  upsertSettlementIntent,
  markIntentSubmitted,
  markIntentRecorded,
  markIntentFailed,
  type SettlementIntent,
} from "@/lib/settlement/intent";
import {
  reconcileSettlementIntent,
  reconcilePendingIntentsForWallet,
} from "@/lib/settlement/reconcile";
import { validateAmount } from "@/lib/expense/validation";
import { planInstallment } from "@/lib/settlement/installments";
import {
  fetchExpenseById,
  updateInstallmentProofRow,
  InstallmentRejectedError,
} from "@/lib/supabase/queries";
import type { SplitShare } from "@/types/expense";
import { trackAnalyticsEvent } from "@/lib/analytics/sink";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface UsePaymentOpts {
  expenseId: string;
}

interface PayShareParams {
  share: SplitShare;
  expenseTitle: string;
  payerWalletAddress: string;
  tripId?: string;
  /**
   * Pay only part of the share (#325). Omitted means "pay the remaining
   * balance"; anything above the remaining balance is rejected before signing.
   */
  amount?: string;
}

// Re-export so consumers can import the type from the hook module directly.
export type { PendingOnChainRecord };

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function usePayment({ expenseId }: UsePaymentOpts) {
  const { publicKey, refreshBalance, network } = useWallet();
  const { markSharePaid, recordShareInstallment } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const { locale } = useLocale();

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
      memoText: string,
      installment?: { claimId: string; memberId: string; seq: number },
    ) => {
      if (!publicKey) return;
      const record: PendingOnChainRecord = {
        memberPublicKey: publicKey,
        tripId,
        expenseId,
        payerPublicKey: payerWalletAddress,
        amountXlm,
        memoText,
        txHash,
        ledger,
        ...(installment
          ? { claimId: installment.claimId, memberId: installment.memberId, installmentSeq: installment.seq }
          : {}),
      };
      persistPendingOnChain(record);
    },
    [publicKey, expenseId, persistPendingOnChain],
  );

  // ---------------------------------------------------------------------------
  // On mount — restore any persisted pending retry from localStorage & reconcile
  // ---------------------------------------------------------------------------

  useEffect(() => {
    if (!publicKey) return;

    // 1. Device-agnostic reconciliation: check Supabase settlement intents (read-only without wallet popup)
    reconcilePendingIntentsForWallet(publicKey, undefined, { allowActiveSubmission: false }).then((results) => {
      // Find if the current expense has a pending on-chain record that needs signing
      const needsSignature = results.find(
        (r) => r.needsOnChainSignature && r.intentId.includes(expenseId)
      );

      if (needsSignature) {
        // If the intent is not already loaded in pendingOnChain, populate it so the Retry button works
        if (!pendingOnChain) {
           const record: PendingOnChainRecord = {
             memberPublicKey: needsSignature.intent.memberWallet,
             tripId: needsSignature.intent.tripId,
             expenseId: needsSignature.intent.expenseId,
             payerPublicKey: needsSignature.intent.payerWallet,
             amountXlm: needsSignature.intent.amount,
             memoText: "", // Re-recording on chain doesn't strictly need memo
             txHash: needsSignature.intent.txHash!,
             ledger: needsSignature.intent.ledger ?? 0,
           };
           setPendingOnChainState(record);
        }

        setPaymentState({
          status: "partial_success",
          hash: needsSignature.intent.txHash!,
          ledger: needsSignature.intent.ledger ?? 0,
          onChain: false,
          message: "A previous on-chain recording attempt requires your signature. Click Retry to complete it.",
        });
      }
    }).catch(() => {});

    // 2. Restore local retry state if present
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
      const amountError = validateAmount(amountXlm, "XLM");
      if (amountError) {
        toastError("Invalid deposit amount", amountError);
        return false;
      }
      setDepositLoading(true);
      try {
        const result = await depositPoolBalance(publicKey, amountXlm);
        if (result.success) {
          const { formatted } = formatMoney(amountXlm, "XLM", locale);
          toastSuccess(
            "Deposit successful",
            `Deposited ${formatted} into pool.`,
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
    [publicKey, loadPoolBalance, toastError, toastSuccess, locale],
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
    const requestId = createRequestId();

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

    // The oracle re-verifies against Horizon itself; there is no point doing a
    // client-side check first, and its verdict would carry no weight anyway.
    // Installments are attested and recorded under their own claim id (#325).
    const claimExpenseId = pendingOnChain.claimId ?? pendingOnChain.expenseId;
    const attested = await fetchAttestation({ ...pendingOnChain, expenseId: claimExpenseId, requestId });

    if (!attested.ok) {
      reportError(
        "payment.attestation-failed",
        new Error(attested.message),
        {
          stage: "retryOnChainRecord",
          tripId: pendingOnChain.tripId,
          expenseId: pendingOnChain.expenseId,
          txHash: pendingOnChain.txHash,
          retryable: attested.retryable,
        },
        "error",
        requestId,
      );
      setPaymentState({
        status: "partial_success",
        hash: pendingOnChain.txHash,
        ledger: pendingOnChain.ledger,
        onChain: false,
        message: attested.message,
      });
      toastError(
        attested.retryable ? "On-chain proof unavailable" : "On-chain retry blocked",
        attested.message,
      );
      return;
    }

    const contractResult = await recordPaymentOnChain({
      ...pendingOnChain,
      expenseId: claimExpenseId,
      requestId,
      attestation: attested.attestation,
      onStatus: (step) => setPaymentState({ status: "recording", step }),
    });

    if (!contractResult.success) {
      const msg = contractResult.error ?? "On-chain retry failed.";
      reportError(
        "payment.contract-recording-failed",
        new Error(msg),
        {
          stage: "retryOnChainRecord",
          tripId: pendingOnChain.tripId,
          expenseId: pendingOnChain.expenseId,
          txHash: pendingOnChain.txHash,
        },
        "error",
        requestId,
      );
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

    if (pendingOnChain.claimId && pendingOnChain.memberId) {
      updateInstallmentProofRow(pendingOnChain.expenseId, pendingOnChain.memberId, pendingOnChain.txHash, {
        verified: true,
        onChain: true,
        attestationNonce: attested.attestation.claim.nonce,
        ledger: contractResult.ledger ?? pendingOnChain.ledger,
      }).catch(() => {});
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
    async ({ share: givenShare, expenseTitle, payerWalletAddress, tripId, amount }: PayShareParams) => {
      const requestId = createRequestId();

      if (!publicKey) {
        toastError("Wallet not connected", "Please connect your Freighter wallet first.");
        return;
      }

      // Plan against the freshest share we can read, so a payment made from
      // another device since this page loaded is counted before anything is
      // signed. The RPC re-checks at write time either way.
      let share = givenShare;
      try {
        const fresh = await fetchExpenseById(expenseId);
        const freshShare = fresh?.shares.find((s) => s.memberId === givenShare.memberId);
        if (freshShare) share = { ...givenShare, ...freshShare };
      } catch {
        // Offline or no session: fall back to the share we were given.
      }

      const plan = planInstallment(share, expenseId, amount);
      if (!plan.ok) {
        if (plan.code === "ALREADY_SETTLED") {
          toastError("Already settled", plan.message);
        } else {
          setPaymentState({ status: "blocked", message: plan.message });
          toastError(plan.code === "OVERPAYMENT" ? "Overpayment not allowed" : "Invalid payment amount", plan.message);
        }
        return;
      }
      // The single-payment path keeps the share's own amount string exactly.
      const payAmount = plan.isInstallment ? plan.amount : share.amount;
      const claimExpenseId = plan.claimId ?? expenseId;
      const installment = plan.isInstallment
        ? { claimId: claimExpenseId, memberId: share.memberId, seq: plan.seq }
        : undefined;

      const amountError = validateAmount(payAmount, "XLM");
      if (amountError) {
        toastError("Invalid payment amount", amountError);
        return;
      }

      // Invariant 1: network configuration must be consistent and safe.
      const configErrors = getNetworkConfigErrors();
      if (configErrors.length > 0) {
        const errorMsg = `Payment blocked: network configuration is invalid (${configErrors[0]})`;
        setPaymentState({ status: "blocked", message: errorMsg });
        toastError("Configuration invalid", errorMsg);
        reportError(
          "payment.blocked-config-invalid",
          new Error(errorMsg),
          { stage: "payShare", configErrors },
          "error",
          requestId,
        );
        return;
      }

      // Invariant 2: a wallet on a different network than the app must be
      // blocked from signing, with a clear explanation. We detect it here —
      // at the money path — rather than only at connect time, because the
      // wallet's network can change mid-session.
      const mismatchMsg = networkMismatchMessage(network);
      if (mismatchMsg) {
        setPaymentState({ status: "blocked", message: mismatchMsg });
        toastError("Network mismatch", mismatchMsg);
        reportError(
          "payment.blocked-network-mismatch",
          new Error(mismatchMsg),
          {
            stage: "payShare",
            amount: payAmount,
            walletNetwork: network,
            appNetwork: STELLAR_NETWORK,
          },
          "error",
          requestId,
        );
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

      // Pre-flight 1: check if already settled on-chain before building the TX
      if (CONTRACT_ID && share.walletAddress) {
        const alreadyPaid = await checkIsPaid(publicKey, claimExpenseId, share.walletAddress);
        if (alreadyPaid.paid) {
          toastError(
            "Already settled on-chain",
            plan.isInstallment
              ? `Installment #${plan.seq} was already recorded on Stellar. Refresh to see the updated balance.`
              : "This payment was already recorded on Stellar. No action needed.",
          );
          return;
        }
      }

      // Pre-flight 2: Acquire durable settlement intent (Invariant 3 — prevent double payment)
      let intent: SettlementIntent | null = null;
      try {
        const intentResult = await acquireSettlementIntent({
          requestId,
          tripId: tripId ?? "none",
          expenseId,
          memberId: share.memberId,
          payerWallet: payerWalletAddress,
          memberWallet: publicKey,
          amount: payAmount,
          txHash: pendingOnChain?.txHash,
          ...(plan.isInstallment ? { installmentSeq: plan.seq } : {}),
        });

        if (!intentResult.ok) {
          if (intentResult.code === "ALREADY_RECORDED") {
            toastError(
              "Already settled on-chain",
              plan.isInstallment
                ? `Installment #${plan.seq} was already recorded. Refresh to see the remaining balance.`
                : intentResult.message,
            );
            return;
          }
          if (intentResult.code === "SUBMITTED_NEEDS_RECONCILIATION") {
            toastInfo("Reconciling settlement...", "Previous payment detected on Stellar.");
            setPaymentState({ status: "recording", step: "simulating" });
            const recon = await reconcileSettlementIntent(intentResult.intent, undefined, {
              allowActiveSubmission: true,
            });
            if (recon.reconciled) {
              setPaymentState({
                status: "success",
                hash: intentResult.intent.txHash!,
                ledger: intentResult.intent.ledger ?? 0,
                onChain: recon.onChain,
              });
              toastSuccess("Settlement reconciled", "Share marked paid from on-chain proof.");
              return;
            }
            // Money already moved for this share; paying again without a lock
            // could double-pay it. Wait for reconciliation to converge instead.
            const msg =
              recon.message ??
              "A previous payment for this share is still being confirmed on Stellar. Try again shortly.";
            setPaymentState({ status: "blocked", message: msg });
            toastError("Previous payment still confirming", msg);
            return;
          }
          if (intentResult.code === "IN_PROGRESS") {
            setPaymentState({ status: "blocked", message: intentResult.message });
            toastError("Settlement in progress", intentResult.message);
            return;
          }
        } else {
          intent = intentResult.intent;
        }
      } catch (err) {
        reportError(
          "settlement.intent-acquire-failed",
          err,
          { stage: "payShare", tripId, expenseId },
          "warning",
          requestId,
        );
      }

      try {
        if (CONTRACT_ID && tripId) {
          const poolCheck = await precheckPoolBalance(publicKey, publicKey, payAmount);
          if (!poolCheck.ok) {
            const msg =
              poolCheck.error ?? "Add enough pool credit before sending this payment.";
            setPaymentState({ status: "blocked", message: msg });
            toastError("Pool credit required", msg);
            await loadPoolBalance();
            if (intent) markIntentFailed(intent.id, msg).catch(() => {});
            return;
          }
        }

        const startTime = Date.now();
        trackAnalyticsEvent("payment_started", {
          currency: "XLM",
          on_chain: Boolean(CONTRACT_ID && tripId),
        });

        setPaymentState({ status: "building" });
        // The sequence leads so it survives the 28-byte memo trim.
        const memoText = plan.isInstallment
          ? `#${plan.seq}|${expenseTitle}|${share.name}`
          : `${expenseTitle}|${share.name}`;
        const { xdr } = await buildPaymentTransaction({
          sourcePublicKey:      publicKey,
          destinationPublicKey: payerWalletAddress,
          amount:               payAmount,
          memoText,
        });

        setPaymentState({ status: "signing" });
        toastInfo("Waiting for wallet signature...", "Review and confirm the transaction.");
        const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE);

        setPaymentState({ status: "submitting" });
        const result = await submitSignedTransaction(signedXDR, requestId);

        // Update durable intent immediately upon successful Horizon submission (Money has moved!)
        if (intent) {
          try {
            await markIntentSubmitted(intent.id, result.hash, result.ledger);
          } catch (err) {
            console.warn("[usePayment] Failed to update intent status to submitted:", err);
          }
        } else {
          try {
            intent = await upsertSettlementIntent({
              requestId,
              tripId: tripId ?? "none",
              expenseId,
              memberId: share.memberId,
              payerWallet: payerWalletAddress,
              memberWallet: publicKey,
              amount: payAmount,
              currency: "XLM",
              status: "submitted",
              txHash: result.hash,
              ledger: result.ledger,
              ...(plan.isInstallment ? { installmentSeq: plan.seq } : {}),
            });
          } catch (err) {
            console.warn("[usePayment] Failed to upsert intent on submit:", err);
          }
        }

        let onChain = false;
        let onChainError: string | null = null;
        let finalLedger = result.ledger;
        let attestationNonce: string | null = null;

        if (CONTRACT_ID && tripId) {
          setPaymentState({ status: "recording", step: "simulating" });

          // The settlement proof now comes from the oracle, which checks
          // Horizon server-side. The client no longer verifies its own claim.
          const attested = await fetchAttestation({
            requestId,
            tripId,
            expenseId: claimExpenseId,
            payerPublicKey: payerWalletAddress,
            memberPublicKey: publicKey,
            amountXlm: payAmount,
            txHash: result.hash,
          });

          if (!attested.ok) {
            onChainError = attested.message;
            reportError(
              "payment.attestation-failed",
              new Error(attested.message),
              {
                stage: "payShare",
                tripId,
                expenseId,
                txHash: result.hash,
                retryable: attested.retryable,
              },
              "error",
              requestId,
            );
            buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, payAmount, tripId, memoText, installment);
          } else {
            attestationNonce = attested.attestation.claim.nonce;
            const contractResult = await recordPaymentOnChain({
              requestId,
              memberPublicKey: publicKey,
              tripId,
              expenseId:      claimExpenseId,
              payerPublicKey: payerWalletAddress,
              amountXlm:      payAmount,
              txHash:         result.hash,
              attestation:    attested.attestation,
              onStatus:       (step) => setPaymentState({ status: "recording", step }),
            });

            if (contractResult.success) {
              onChain = true;
              finalLedger = contractResult.ledger ?? result.ledger;
              loadPoolBalance();
            } else {
              onChainError = contractResult.error ?? "On-chain recording failed.";
              reportError(
                "payment.contract-recording-failed",
                new Error(onChainError),
                {
                  stage: "payShare",
                  tripId,
                  expenseId,
                  txHash: result.hash,
                },
                "error",
                requestId,
              );
              buildAndPersistPending(result.hash, result.ledger, payerWalletAddress, payAmount, tripId, memoText, installment);
            }
          }
        }

        // Always sync local state after successful XLM transfer so UI reflects financial reality.
        if (plan.isInstallment) {
          try {
            await recordShareInstallment(expenseId, share.memberId, {
              seq: plan.seq,
              amount: payAmount,
              txHash: result.hash,
              claimId: claimExpenseId,
              ledger: finalLedger,
              attestationNonce,
              verified: attestationNonce !== null,
              onChain,
            });
          } catch (err) {
            if (err instanceof InstallmentRejectedError) {
              // Money has moved but the balance moved first: never record it as
              // credit implicitly. Surface it so the payer can refund or credit.
              const msg =
                `The ${payAmount} XLM payment landed (TX ${result.hash.slice(0, 12)}...) but exceeds ` +
                "this share's remaining balance, so it was not applied. Ask the recipient to refund " +
                "or credit the difference.";
              if (intent) markIntentFailed(intent.id, msg).catch(() => {});
              setPaymentState({ status: "error", message: msg });
              reportError(
                "payment.installment-rejected",
                err,
                { stage: "payShare", tripId, expenseId, txHash: result.hash, reason: err.reason },
                "error",
                requestId,
              );
              toastError("Installment not applied", msg);
              return;
            }
            throw err;
          }
        } else {
          await markSharePaid(expenseId, share.memberId, result.hash);
        }

        if (intent) {
          try {
            await markIntentRecorded(intent.id, finalLedger, onChain);
          } catch {}
        }

        if (onChainError) {
          trackAnalyticsEvent("payment_completed", {
            currency: "XLM",
            on_chain: false,
            duration_ms: Date.now() - startTime,
          });
          setPaymentState({
            status: "partial_success",
            hash: result.hash,
            ledger: finalLedger,
            onChain: false,
            message: onChainError,
          });
          reportError(
            "payment.onchain-proof-failed",
            new Error(onChainError),
            {
              stage: "payShare",
              hash: result.hash,
              ledger: result.ledger,
              amount: payAmount,
              tripId,
            },
            "error",
            requestId,
          );
          toastInfo(
            "Payment sent — recorded off-chain only",
            "The XLM transfer succeeded, but this settlement has no on-chain proof yet. Use retry to add it.",
          );
          setTimeout(() => refreshBalance(), 3000);
          setTimeout(() => refreshBalance(), 8000);
          return;
        }

        trackAnalyticsEvent("payment_completed", {
          currency: "XLM",
          on_chain: onChain,
          duration_ms: Date.now() - startTime,
        });

        setPaymentState({ status: "success", hash: result.hash, ledger: finalLedger, onChain });
        toastSuccess(
          plan.isInstallment
            ? plan.isFinal
              ? `Installment #${plan.seq} paid — share fully settled`
              : `Installment #${plan.seq} paid · ${plan.remainingAfter} XLM remaining`
            : `Paid ${parseFloat(share.amount).toFixed(4)} XLM to ${share.name}`,
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

        trackAnalyticsEvent("payment_failed", {
          currency: "XLM",
          error_code: isRejected ? "user_rejected" : "payment_failed",
        });

      setPaymentState({ status: "error", message: display });
      reportError(
        "payment.failed",
        err,
        {
          stage: "payShare",
          amount: payAmount,
          tripId,
        },
        "error",
        requestId,
      );
      toastError("Payment failed", display);
    }
    },
    [
      publicKey,
      expenseId,
      markSharePaid,
      recordShareInstallment,
      refreshBalance,
      toastSuccess,
      toastError,
      toastInfo,
      loadPoolBalance,
      buildAndPersistPending,
      network,
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
