"use client";

import React, { useMemo, useState } from "react";
import { motion } from "framer-motion";
import { ArrowRight, Scale, CheckCircle2, Database } from "lucide-react";
import type { Expense } from "@/types/expense";
import type { Trip } from "@/types/trip";
import type { ContractPaymentEvent } from "@/types/contract";
import type { NetPayment, RawDebt } from "@/lib/settlement/netBalance";
import { computeNetPayments } from "@/lib/settlement/netBalance";
import { buildPaymentTransaction } from "@/lib/stellar/buildTransaction";
import { submitSignedTransaction } from "@/lib/stellar/submitTransaction";
import { signXDR } from "@/lib/freighter";
import { useWallet } from "@/hooks/useWallet";
import { useExpense } from "@/hooks/useExpense";
import { useToast } from "@/components/ui/Toast";
import { NETWORK_PASSPHRASE } from "@/lib/utils/constants";
import { PayButton } from "@/components/payment/PayButton";
import { TransactionHash } from "@/components/payment/TransactionHash";
import { cn } from "@/lib/utils";

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
        from:       share.name,
        to:         payer.name,
        amount:     parseFloat(share.amount),
        fromWallet: share.walletAddress,
        toWallet:   payer.walletAddress,
      });
    }
  }
  return debts;
}

function NetPaymentRow({
  payment,
  index,
  tripName,
  expenses,
  isOnChain,
}: {
  payment: NetPayment;
  index: number;
  tripName: string;
  expenses: Expense[];
  isOnChain: boolean;
}) {
  const { publicKey } = useWallet();
  const { markSharePaid } = useExpense();
  const { success: toastSuccess, error: toastError, info: toastInfo } = useToast();
  const [rowState, setRowState] = useState<RowState>({ status: "idle" });

  const canPay =
    publicKey &&
    payment.toWallet &&
    rowState.status === "idle" &&
    publicKey === payment.fromWallet;

  const handlePay = async () => {
    if (!publicKey || !payment.toWallet) return;
    try {
      setRowState({ status: "paying" });
      const memo = `Stellar Star|${tripName}`.slice(0, 28);
      const { xdr } = await buildPaymentTransaction({
        sourcePublicKey:      publicKey,
        destinationPublicKey: payment.toWallet,
        amount:               payment.amount,
        memoText:             memo,
      });
      toastInfo("Waiting for Freighter…", "Confirm the settlement payment.");
      const signedXDR = await signXDR(xdr, NETWORK_PASSPHRASE);
      const { hash }  = await submitSignedTransaction(signedXDR);

      for (const expense of expenses) {
        const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
        if (!payer || payer.name !== payment.to) continue;
        for (const share of expense.shares) {
          if (share.name === payment.from && !share.paid) {
            try { await markSharePaid(expense.id, share.memberId, hash); } catch { /* non-fatal */ }
          }
        }
      }

      setRowState({ status: "done", txHash: hash });
      toastSuccess(
        "Settlement sent!",
        `Paid ${parseFloat(payment.amount).toFixed(4)} XLM to ${payment.to}`,
      );
    } catch (err: unknown) {
      const msg        = err instanceof Error ? err.message : "Payment failed";
      const isRejected = /reject|denied|cancel/i.test(msg);
      toastError(
        isRejected ? "Transaction cancelled" : "Payment failed",
        isRejected ? "You rejected the payment in Freighter." : msg,
      );
      setRowState({ status: "idle" });
    }
  };

  const done    = rowState.status === "done";
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
            {parseFloat(payment.amount).toFixed(4)}{" "}
            <span className="text-[10px] font-normal text-[#888]">XLM</span>
          </span>

          {settled ? (
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
              {isOnChain && !done ? (
                <><Database size={9} /> On-chain</>
              ) : (
                <><CheckCircle2 size={9} /> Paid</>
              )}
            </span>
          ) : (
            <PayButton
              amount={payment.amount}
              recipientName={payment.to}
              onClick={handlePay}
              isLoading={rowState.status === "paying"}
              disabled={!canPay}
              size="sm"
            />
          )}
        </div>
      </div>

      {done && (
        <div className="pl-1">
          <TransactionHash hash={rowState.txHash} compact />
        </div>
      )}

      {isOnChain && !done && (
        <p className="text-[10px] text-[#5a9400] pl-1 flex items-center gap-1">
          <Database size={9} />
          Confirmed on Stellar — ledger proof recorded
        </p>
      )}

      {!settled && rowState.status === "idle" && publicKey && publicKey !== payment.fromWallet && (
        <p className="text-[10px] text-[#AAA] pl-1">
          Connect {payment.from}&apos;s wallet to pay
        </p>
      )}
    </motion.div>
  );
}

export function SettlementSummary({ trip, expenses, onChainEvents = [] }: SettlementSummaryProps) {
  const rawDebts    = useMemo(() => deriveRawDebts(expenses), [expenses]);
  const netPayments = useMemo(() => computeNetPayments(rawDebts), [rawDebts]);

  // Build a set of on-chain confirmed wallet addresses (members who settled)
  const onChainMembers = useMemo(
    () => new Set(onChainEvents.map((e) => e.member.toLowerCase())),
    [onChainEvents],
  );

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
          expenses={expenses}
          isOnChain={!!(p.fromWallet && onChainMembers.has(p.fromWallet.toLowerCase()))}
        />
      ))}
    </div>
  );
}
