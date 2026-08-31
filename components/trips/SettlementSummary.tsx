"use client";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Scale, CheckCircle2, Database, ArrowRightLeft } from "lucide-react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import type { ContractPaymentEvent } from "@/types/contract";
import type { NetPayment, RawDebt } from "@/lib/settlement/netBalance";
import { computeNetPayments } from "@/lib/settlement/netBalance";
import { buildPaymentTransaction, trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { parseAssetKey, assetKey, isNative } from "@/lib/stellar/assets";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { PayButton } from "@/components/payment/PayButton";
import { TransactionHash } from "@/components/payment/TransactionHash";
import { PathPaymentConfirm } from "@/components/payment/PathPaymentConfirm";
import { cn } from "@/lib/utils";
import { useNetPayment } from "@/hooks/useNetPayment";
import { usePathPayment } from "@/hooks/usePathPayment";
import { buildPaymentEventKey } from "@/lib/stellar/events";
import { Money } from "@/components/ui/Money";

interface SettlementSummaryProps {
  trip: Trip;
  expenses: Expense[];
  onChainEvents?: ContractPaymentEvent[];
}

type RowState =
  | { status: "idle" }
  | { status: "paying" }
  | { status: "done"; txHash: string };

function deriveRawDebts(expenses: Expense[]): RawDebt[] {
  const debts: RawDebt[] = [];
  for (const expense of expenses) {
    for (const share of expense.shares) {
      const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
      if (!payer || share.memberId === expense.paidByMemberId) continue;
      if (share.paid) continue;
      debts.push({
        expenseId:  expense.id,
        fromId:     share.memberId,
        toId:       payer.id,
        from:       share.name,
        to:         payer.name,
        amount:     parseFloat(share.amount),
        asset:      expense.currency || "XLM",
        fromWallet: share.walletAddress,
        toWallet:   payer.walletAddress,
      });
    }
  }
  return debts;
}

// Converts an XLM amount (either a number or a string representation) into Stroops (the smallest subunit of XLM).
export function xlmToStroops(amount: string | number): string {
  const amountStr = typeof amount === "number" ? amount.toFixed(7) : amount;
  const [whole, fraction = ""] = amountStr.split(".");
  const normalizedWhole = whole.replace(/^0+(?=\d)/, "") || "0";
  const normalizedFraction = (fraction + "0000000").slice(0, 7);
  return `${BigInt(normalizedWhole) * 10_000_000n + BigInt(normalizedFraction)}`;
}

// Builds a lookup key for a debt row in the UI to match against on-chain payment keys using the exact trip, expense, debtor wallet, and amount in stroops.
function buildDebtKey(tripId: string, debt: RawDebt) {
  if (!debt.fromWallet) return null;
  const amountStroops = xlmToStroops(debt.amount);
  const canonicalAsset = assetKey(parseAssetKey(debt.asset));
  return `${tripId}:${debt.expenseId}:${debt.fromWallet.toLowerCase()}:${amountStroops}:${canonicalAsset}`;
}

function NetPaymentRow({
  payment,
  index,
  tripName,
  tripId,
  expenses,
  isOnChain,
}: {
  payment: NetPayment;
  index: number;
  tripName: string;
  tripId: string;
  expenses: Expense[];
  isOnChain: boolean;
}) {
  const { publicKey } = useWallet();
  const {
    paymentState,
    payNetSettlement,
    payNetPathSettlement,
    retryOnChainRecord,
    loadPendingForPayer,
    hasPendingRetry,
    txHash,
    onChain,
    isIdle,
    isLoading,
    isSuccess,
  } = useNetPayment({ tripId });

  const [showPathConfirm, setShowPathConfirm] = useState(false);
  const destinationAssetRef = useMemo(() => parseAssetKey(payment.asset), [payment.asset]);

  const {
    path,
    loading: pathLoading,
    failure: pathFailure,
    slippageBps,
    setSlippageBps,
    refreshQuote,
    clear: clearPathQuote,
  } = usePathPayment({
    sourceAccount: publicKey,
    destinationAccount: payment.toWallet || null,
    destinationAsset: destinationAssetRef,
    destinationAmount: payment.amount,
  });

  React.useEffect(() => {
    if (payment.toWallet) {
      loadPendingForPayer(payment.toWallet);
    }
  }, [loadPendingForPayer, payment.toWallet]);

  const canPay =
    publicKey &&
    payment.toWallet &&
    isIdle &&
    publicKey === payment.fromWallet;

  const handlePay = async () => {
    if (!payment.toWallet) return;
    await payNetSettlement({
      debts: payment.settledDebts,
      totalAmount: payment.amount,
      asset: payment.asset,
      payerWalletAddress: payment.toWallet,
      tripName,
    });
  };

  const handleOpenPathPayment = () => {
    setShowPathConfirm(true);
    refreshQuote();
  };

  const handleConfirmPathPayment = async () => {
    if (!path || !payment.toWallet) return;
    setShowPathConfirm(false);
    await payNetPathSettlement({
      debts: payment.settledDebts,
      tripName,
      payerWalletAddress: payment.toWallet,
      path,
    });
  };

  const done    = isSuccess || onChain;
  const settled = done || isOnChain;

  return (
    <motion.div
      initial={{ opacity: 0, x: -8 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: index * 0.06 }}
      className={cn(
        "flex flex-col gap-2 p-3.5 rounded-xl border transition-all",
        settled ? "bg-[#F0FFDB] border-[#2DD4BF]/40" : "bg-white border-[#E5E5E5]",
      )}
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
        <div className="flex items-center gap-2 min-w-0 text-sm font-semibold text-[#0F0F14]">
          <span className="truncate">{payment.from}</span>
          <ArrowRight size={13} className="text-[#2DD4BF] shrink-0" />
          <span className="truncate">{payment.to}</span>
        </div>

        <div className="flex items-center justify-between sm:justify-end gap-2">
          <span className="text-sm font-bold">
            <Money amount={payment.amount} asset={payment.asset} />
          </span>

          {hasPendingRetry && paymentState.status === "partial_success" ? (
            <div className="flex flex-col gap-1 items-end">
              <span className="text-[10px] text-orange-600 font-medium">
                {payment.asset} sent. Pool record failed.
              </span>
              <button
                onClick={retryOnChainRecord}
                disabled={isLoading}
                className="bg-orange-100 hover:bg-orange-200 text-orange-800 text-[10px] px-2 py-1 rounded-md font-bold transition-colors disabled:opacity-50"
              >
                {isLoading ? "Retrying..." : "Retry contract record"}
              </button>
            </div>
          ) : settled ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
              {isOnChain && !done ? (
                <><Database size={9} /> On-chain</>
              ) : (
                <><CheckCircle2 size={9} /> Paid</>
              )}
            </span>
          ) : (
            <div className="flex items-center gap-1.5">
              <PayButton
                amount={payment.amount}
                asset={payment.asset}
                recipientName={payment.to}
                onClick={handlePay}
                isLoading={isLoading}
                disabled={!canPay}
                size="sm"
              />
              <button
                type="button"
                onClick={handleOpenPathPayment}
                disabled={!canPay || isLoading}
                title="Convert & pay using an asset you already hold (Stellar DEX path payment)"
                className="inline-flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-xl border border-[#E5E5E5] text-[#555] hover:border-[#2DD4BF] hover:text-[#0F0F14] disabled:opacity-40 disabled:cursor-not-allowed transition-all font-semibold"
              >
                <ArrowRightLeft size={11} className="text-[#2DD4BF]" />
                <span>Convert</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {(done || paymentState.status === "partial_success") && txHash && (
        <div className="pl-1">
          <TransactionHash hash={txHash} compact />
        </div>
      )}

      {isOnChain && !done && (
        <p className="text-[10px] text-[#5a9400] pl-1 flex items-center gap-1">
          <Database size={9} />
          Confirmed on Stellar - ledger proof recorded
        </p>
      )}

      {!settled && isIdle && publicKey && publicKey !== payment.fromWallet && (
        <p className="text-[10px] text-[#AAA] pl-1">
          Connect {payment.from}&apos;s wallet to pay
        </p>
      )}

      <PathPaymentConfirm
        open={showPathConfirm}
        onClose={() => {
          setShowPathConfirm(false);
          clearPathQuote();
        }}
        recipientName={payment.to}
        path={path}
        loading={pathLoading}
        failure={pathFailure}
        slippageBps={slippageBps}
        onSlippageChange={setSlippageBps}
        onRefreshQuote={refreshQuote}
        onConfirm={handleConfirmPathPayment}
      />
    </motion.div>
  );
}

export function SettlementSummary({ trip, expenses, onChainEvents = [] }: SettlementSummaryProps) {
  const rawDebts    = useMemo(() => deriveRawDebts(expenses), [expenses]);
  const netPayments = useMemo(() => computeNetPayments(rawDebts), [rawDebts]);

  const onChainPaymentKeys = useMemo(
    () => new Set(onChainEvents.map(buildPaymentEventKey)),
    [onChainEvents],
  );

  const isNetPaymentOnChain = (payment: NetPayment) =>
    payment.settledDebts.every((debt) => {
      const key = buildDebtKey(trip.id, debt);
      return key ? onChainPaymentKeys.has(key) : false;
    });

  if (netPayments.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-8 text-center rounded-xl border border-dashed border-[#D0D0D0]">
        <Scale size={20} className="text-[#2DD4BF]" />
        <p className="text-sm font-semibold text-[#0F0F14]">All settled up!</p>
        <p className="text-xs text-[#AAA]">No outstanding balances in this trip.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Scale size={14} className="text-[#2DD4BF]" />
          <h3 className="text-sm font-bold text-[#0F0F14]">
            Settlement ({netPayments.length} payment{netPayments.length !== 1 ? "s" : ""})
          </h3>
        </div>
        {onChainEvents.length > 0 && (
          <span className="inline-flex items-center gap-1 text-[10px] font-bold text-[#134E4A] bg-[#2DD4BF]/20 px-2 py-0.5 rounded-full">
            <Database size={9} />
            {onChainEvents.length} on-chain
          </span>
        )}
      </div>

      {netPayments.map((p, i) => (
        <NetPaymentRow
          key={`${p.from}-${p.to}-${i}`}
          payment={p}
          index={i}
          tripName={trip.name}
          tripId={trip.id}
          expenses={expenses}
          isOnChain={isNetPaymentOnChain(p)}
        />
      ))}
    </div>
  );
}
