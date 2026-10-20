"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, CheckCircle2, ShieldCheck } from "lucide-react";
import { useExpense } from "@/hooks/useExpense";
import { useTrip } from "@/hooks/useTrip";
import { useWallet } from "@/hooks/useWallet";
import { usePayment } from "@/hooks/usePayment";
import { useNetPayment, type RawDebt } from "@/hooks/useNetPayment";
import { useToast } from "@/components/ui/Toast";
import { TransactionHash } from "@/components/payment/TransactionHash";
import { Money } from "@/lib/money";
import {
  checkPaymentRequest,
  decodePaymentRequest,
  describePaymentRequest,
  itemKey,
  PaymentRequestError,
  type ItemState,
  type PaymentRequest,
} from "@/lib/qr/paymentRequest";
import { settlementAssetOf } from "@/lib/settlement/expenseAsset";
import { STELLAR_NETWORK } from "@/lib/utils/constants";
import type { Expense } from "@/types/expense";

function liveItemStates(request: PaymentRequest, expenses: Expense[]): Map<string, ItemState> {
  const states = new Map<string, ItemState>();
  for (const item of request.items) {
    const expense = expenses.find((e) => e.id === item.expenseId);
    const share = expense?.shares.find((s) => s.memberId === item.memberId);
    if (!expense || !share) continue;
    const payer = expense.members.find((m) => m.id === expense.paidByMemberId);
    states.set(itemKey(item), {
      outstanding: share.paid ? "0.0000000" : (Money.tryParse(share.amount)?.format() ?? null),
      creditorWallet: payer?.walletAddress ?? null,
    });
  }
  return states;
}

/**
 * Pays a `/pay?r=…` request (#327): a human-readable preview first, then the
 * same checks as the QR — expiry, network, recipient, outstanding balance —
 * re-run against live data immediately before the wallet is asked to sign.
 */
export function PaymentRequestCheckout({ encoded }: { encoded: string }) {
  const { publicKey, network } = useWallet();
  const { expenses, isLoading } = useExpense();
  const { trips } = useTrip();
  const { error: toastError } = useToast();
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));

  const decoded = useMemo((): { request: PaymentRequest } | { error: string } => {
    try {
      return { request: decodePaymentRequest(encoded) };
    } catch (err) {
      return { error: err instanceof PaymentRequestError ? err.message : "This payment link is damaged." };
    }
  }, [encoded]);
  const request = "request" in decoded ? decoded.request : null;

  const share = usePayment({ expenseId: request?.items[0]?.expenseId ?? "" });
  const net = useNetPayment({ tripId: request?.tripId ?? "" });
  const active = request?.kind === "net" ? net : share;

  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 15_000);
    return () => clearInterval(id);
  }, []);

  if (!request) {
    return <p role="alert" className="text-sm text-red-600">{"error" in decoded ? decoded.error : ""}</p>;
  }
  if (isLoading) return <p className="text-sm text-[#888]">Loading the request…</p>;

  const preview = describePaymentRequest(request, now);
  const check = checkPaymentRequest(request, {
    nowSeconds: now,
    appNetwork: STELLAR_NETWORK,
    walletNetwork: network,
    payerWallet: publicKey,
    items: liveItemStates(request, expenses),
  });
  const tripName = trips.find((t) => t.id === request.tripId)?.name ?? "Trip";
  const paid = active.isSuccess || active.paymentState.status === "partial_success";

  const pay = async () => {
    // Re-check at the last moment: the request may have expired, or been paid
    // from another device, while this page was open.
    const latest = checkPaymentRequest(request, {
      appNetwork: STELLAR_NETWORK,
      walletNetwork: network,
      payerWallet: publicKey,
      items: liveItemStates(request, expenses),
    });
    if (!latest.ok) {
      toastError("Payment blocked", latest.blockers[0].message);
      return;
    }

    if (request.kind === "share") {
      const item = request.items[0];
      const expense = expenses.find((e) => e.id === item.expenseId)!;
      const target = expense.shares.find((s) => s.memberId === item.memberId)!;
      await share.payShare({
        share: target,
        expenseTitle: expense.title,
        payerWalletAddress: request.destination,
        tripId: request.tripId,
      });
      return;
    }

    const debts: RawDebt[] = request.items.map((item) => {
      const expense = expenses.find((e) => e.id === item.expenseId)!;
      const target = expense.shares.find((s) => s.memberId === item.memberId)!;
      const payer = expense.members.find((m) => m.id === expense.paidByMemberId)!;
      return {
        expenseId: expense.id,
        fromId: target.memberId,
        toId: payer.id,
        from: target.name,
        to: payer.name,
        amount: item.amount,
        asset: settlementAssetOf(expense),
        fromWallet: target.walletAddress,
        toWallet: payer.walletAddress,
      };
    });
    await net.payNetSettlement({
      debts,
      totalAmount: request.amount,
      asset: request.asset,
      payerWalletAddress: request.destination,
      tripName,
    });
  };

  return (
    <div className="space-y-4">
      <h1 className="flex items-center gap-2 text-lg font-black text-[#0F0F14]">
        <ShieldCheck size={20} className="text-[#2DD4BF]" />
        Review payment request
      </h1>

      <dl className="grid grid-cols-[auto,1fr] gap-x-3 gap-y-1.5 text-sm" aria-label="Payment request preview">
        {preview.lines.map((line) => (
          <div key={line.label} className="contents">
            <dt className="text-[#888]">{line.label}</dt>
            <dd className="break-all font-medium text-[#0F0F14]">{line.value}</dd>
          </div>
        ))}
      </dl>

      {!paid && check.blockers.length > 0 && (
        <ul className="space-y-1 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert">
          {check.blockers.map((b) => (
            <li key={b.code} className="flex items-start gap-1.5">
              <AlertTriangle size={14} className="mt-0.5 shrink-0" /> {b.message}
            </li>
          ))}
        </ul>
      )}

      {paid && active.txHash ? (
        <div className="space-y-2">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-[#134E4A]">
            <CheckCircle2 size={16} /> Paid
          </p>
          <TransactionHash hash={active.txHash} />
        </div>
      ) : (
        <button
          type="button"
          onClick={pay}
          disabled={!check.ok || !publicKey || active.isLoading}
          className="w-full rounded-xl bg-[#0F0F14] px-4 py-2.5 text-sm font-bold text-[#2DD4BF] disabled:opacity-40"
        >
          {active.isLoading ? "Waiting for wallet…" : `Pay ${request.amount} with my wallet`}
        </button>
      )}

      {!publicKey && <p className="text-xs text-[#888]">Connect the wallet this request is addressed to.</p>}

      <Link href={`/trips/${encodeURIComponent(request.tripId)}`} className="inline-block text-sm font-bold text-[#134E4A] hover:underline">
        Open trip
      </Link>
    </div>
  );
}
