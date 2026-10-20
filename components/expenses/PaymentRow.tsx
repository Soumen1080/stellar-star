"use client";

import React, { useState } from "react";
import { motion } from "framer-motion";
import { ExternalLink, ReceiptIcon } from "lucide-react";
import type { SplitShare } from "@/types/expense";
import { formatAddress } from "@/lib/utils";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import { cn } from "@/lib/utils";
import { PayButton } from "@/components/payment/PayButton";
import { QRToggle } from "@/components/payment/QRCodeDisplay";
import { PaymentRequestToggle } from "@/components/payment/PaymentRequestPanel";
import { ReceiptModal } from "@/components/expenses/ReceiptModal";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { Money } from "@/components/ui/Money";
import { RemindButton } from "@/components/reminders/RemindButton";
import { shareBalance, installmentsOf, planInstallment } from "@/lib/settlement/installments";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PaymentRowProps {
  share: SplitShare;
  index: number;
  expenseTitle?: string;
  /**
   * Called when user clicks "Pay". `amount` is set for a partial payment
   * (#325); omitted means pay the remaining balance.
   */
  onPay?: (share: SplitShare, amount?: string) => void;
  /** When true, show spinner on Pay button (payment in-flight for this share). */
  isPaying?: boolean;
  /** Connected wallet - Pay button is only shown when this matches share.walletAddress.
   *  If undefined/null, falls back to the old behaviour (show for all). */
  connectedWalletAddress?: string | null;
  /** Payer's wallet address - guard against showing Pay for the payer row. */
  payerWalletAddress?: string;
  poolBalance?: string | null;
  depositLoading?: boolean;
  onDepositPool?: (amount: string) => Promise<boolean>;
  /**
   * Enables a SEP-0007 payment request for this share (#327). `exactAmount`
   * is the stored share amount; `share.amount` may be rounded for display.
   */
  paymentRequest?: { tripId: string; expenseId: string; asset: string; exactAmount: string };
}

// ─── Component ────────────────────────────────────────────────────────────────

export function PaymentRow({
  share,
  index,
  expenseTitle = "Expense",
  onPay,
  isPaying = false,
  connectedWalletAddress,
  payerWalletAddress,
  poolBalance,
  depositLoading,
  onDepositPool,
  paymentRequest,
}: PaymentRowProps) {
  const [showReceipt, setShowReceipt] = useState(false);
  const [partialOpen, setPartialOpen] = useState(false);
  const [partialAmount, setPartialAmount] = useState("");
  const explorerUrl = share.walletAddress
    ? `${STELLAR_EXPLORER}/account/${share.walletAddress}`
    : null;
  const memo = trimToMemoBytes(`StellarStar|${expenseTitle}|${share.name}`, 28);

  // The payer NEVER owes anything - guard even if wallets accidentally overlap.
  const isPayerRow =
    !!payerWalletAddress &&
    !!share.walletAddress &&
    share.walletAddress === payerWalletAddress;

  // Show Pay button only when the connected wallet matches this share’s wallet
  // AND this row does not belong to the payer.
  const isMyRow =
    !isPayerRow &&
    (!connectedWalletAddress ||
      (!!share.walletAddress && share.walletAddress === connectedWalletAddress));
  // Owed / paid / remaining in exact stroops (#325). A malformed amount
  // falls back to the share as a whole so the row still renders.
  const balance = (() => {
    try {
      return shareBalance(share);
    } catch {
      return null;
    }
  })();
  const remaining = balance?.remaining ?? share.amount;
  const installments = installmentsOf(share);
  const partialPlan =
    partialAmount.trim() !== "" ? planInstallment(share, "preview", partialAmount) : null;

  const poolBalanceValue = poolBalance === null || poolBalance === undefined ? null : parseFloat(poolBalance);
  const shareAmountValue = parseFloat(
    partialPlan?.ok ? partialPlan.amount : remaining,
  );
  const poolShortfall =
    poolBalanceValue !== null ? Math.max(shareAmountValue - poolBalanceValue, 0) : null;
  const hasEnoughPoolCredit = poolShortfall !== null && poolShortfall <= 0;
  const isPoolCheckBlocking =
    isMyRow && !share.paid && poolBalance !== undefined && !hasEnoughPoolCredit;

  return (
    <>
      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ delay: index * 0.05, duration: 0.25 }}
        className={cn(
          "flex flex-col gap-2 px-4 py-3 rounded-xl border transition-all",
          share.paid
            ? "bg-[#F0FFDB] border-[#2DD4BF]/40"
            : "bg-white border-[#E5E5E5] hover:border-[#D0D0D0]"
        )}
      >
        {/* Top row: avatar / name / amount / action */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 sm:gap-3">
          {/* Avatar + name */}
          <div className="flex items-center gap-3 min-w-0">
            <div
              className={cn(
                "w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-xs font-bold",
                share.paid
                  ? "bg-[#2DD4BF] text-[#0F0F14]"
                  : "bg-[#F0F0F0] text-[#555]"
              )}
            >
              {share.name.charAt(0).toUpperCase()}
            </div>

            <div className="min-w-0">
              <p className="text-sm font-semibold text-[#0F0F14] truncate">
                {share.name}
              </p>
              {share.walletAddress && !share.paid && (
                <a
                  href={explorerUrl ?? "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[11px] text-[#AAA] hover:text-[#555] transition-colors max-w-full"
                  onClick={(e) => e.stopPropagation()}
                >
                  {formatAddress(share.walletAddress, 4)}
                  <ExternalLink size={9} />
                </a>
              )}
              {share.paid && share.txHash && (
                <button
                  onClick={() => setShowReceipt(true)}
                  className="flex items-center gap-1 text-[11px] text-[#134E4A] hover:underline"
                >
                  <ReceiptIcon size={9} />
                  View receipt
                </button>
              )}
            </div>
          </div>

          {/* Amount + action */}
          <div className="flex items-center justify-between sm:justify-end gap-2">
            <span className="text-sm font-bold text-[#0F0F14]">
              <Money amount={share.amount} asset="XLM" />
            </span>

            {balance?.partiallyPaid && !share.paid && (
              <span className="inline-flex items-center text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-amber-100 text-amber-800 rounded-full">
                Partly paid
              </span>
            )}

            {share.paid ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                Paid
              </span>
            ) : isMyRow ? (
              <PayButton
                amount={remaining}
                recipientName={share.name}
                onClick={() => onPay?.(share)}
                isLoading={isPaying}
                disabled={!share.walletAddress || !onPay || isPoolCheckBlocking}
                size="sm"
              />
            ) : (
              <span className="inline-flex items-center text-[10px] font-medium text-[#AAA] px-2 py-0.5 bg-[#F5F5F5] rounded-full">
                Awaiting
              </span>
            )}
          </div>
        </div>
 
        {/* Owed / paid / remaining, once any part of the share is paid (#325) */}
        {balance && balance.installmentCount > 0 && (
          <div className="pl-11 space-y-1.5">
            <dl className="grid grid-cols-3 gap-2 text-[11px]">
              <div>
                <dt className="text-[#AAA]">Owed</dt>
                <dd className="font-semibold text-[#0F0F14]"><Money amount={balance.owed} asset="XLM" /></dd>
              </div>
              <div>
                <dt className="text-[#AAA]">Paid</dt>
                <dd className="font-semibold text-[#134E4A]"><Money amount={balance.paid} asset="XLM" /></dd>
              </div>
              <div>
                <dt className="text-[#AAA]">Remaining</dt>
                <dd className="font-semibold text-[#0F0F14]"><Money amount={balance.remaining} asset="XLM" /></dd>
              </div>
            </dl>
            <ul className="space-y-0.5" aria-label="Installments">
              {installments.map((installment) => (
                <li key={installment.txHash} className="flex flex-wrap items-center gap-x-2 text-[11px] text-[#666]">
                  <span className="font-semibold">#{installment.seq}</span>
                  <Money amount={installment.amount} asset="XLM" />
                  <a
                    href={`${STELLAR_EXPLORER}/tx/${installment.txHash}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 hover:text-[#0F0F14]"
                  >
                    {installment.txHash.slice(0, 8)}… <ExternalLink size={9} />
                  </a>
                  <span className={installment.onChain ? "text-[#134E4A]" : installment.verified ? "text-[#555]" : "text-orange-600"}>
                    {installment.onChain ? "On-chain" : installment.verified ? "Verified" : "Unverified"}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* Pay part of the share (#325) */}
        {isMyRow && !share.paid && onPay && share.walletAddress && (
          <div className="pl-11">
            {partialOpen ? (
              <form
                className="flex flex-wrap items-center gap-2 text-xs"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!partialPlan?.ok) return;
                  onPay(share, partialPlan.amount);
                  setPartialAmount("");
                  setPartialOpen(false);
                }}
              >
                <label className="sr-only" htmlFor={`partial-${share.memberId}`}>
                  Installment amount
                </label>
                <input
                  id={`partial-${share.memberId}`}
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder={`Up to ${remaining}`}
                  value={partialAmount}
                  onChange={(e) => setPartialAmount(e.target.value)}
                  className="w-32 rounded-lg border border-[#E5E5E5] px-2 py-1"
                />
                <button
                  type="submit"
                  disabled={!partialPlan?.ok || isPaying}
                  className="rounded-lg bg-[#0F0F14] px-2.5 py-1 font-semibold text-white disabled:opacity-40"
                >
                  Pay part
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setPartialOpen(false);
                    setPartialAmount("");
                  }}
                  className="text-[#888] hover:text-[#0F0F14]"
                >
                  Cancel
                </button>
                {partialPlan && (
                  <p
                    role={partialPlan.ok ? undefined : "alert"}
                    className={cn("w-full text-[11px]", partialPlan.ok ? "text-[#666]" : "text-red-500")}
                  >
                    {partialPlan.ok
                      ? partialPlan.isFinal
                        ? "This pays the share off."
                        : `${partialPlan.remainingAfter} XLM will remain after this installment.`
                      : partialPlan.message}
                  </p>
                )}
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setPartialOpen(true)}
                disabled={isPaying}
                className="text-[11px] font-semibold text-[#2DD4BF] hover:text-[#25BFA3] underline disabled:opacity-50"
              >
                Pay part of this share
              </button>
            )}
          </div>
        )}

        {/* Pool balance display for the connected user */}
        {isMyRow && !share.paid && poolBalance !== undefined && (
          <div className="pl-11 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs border-t border-[#F5F5F5] pt-2">
            <span className="text-[#666]">
              Contract pool:{" "}
              <strong className="text-[#0F0F14]">
                {poolBalanceValue !== null ? <Money amount={poolBalanceValue} asset="XLM" /> : "Loading..."}
              </strong>
            </span>
            {poolShortfall !== null && (
              <>
                {poolShortfall <= 0 ? (
                  <span className="text-[#134E4A] font-semibold">Ready to record</span>
                ) : (
                  <span className="text-red-500 font-semibold flex items-center gap-1">
                    <span>Shortfall: </span>
                    <Money amount={poolShortfall} asset="XLM" />
                  </span>
                )}
                {poolShortfall > 0 && (
                  <button
                    disabled={depositLoading}
                    onClick={() => onDepositPool?.(poolShortfall.toFixed(7))}
                    className={cn(
                      "font-bold text-[#2DD4BF] hover:text-[#25BFA3] transition-colors underline disabled:opacity-50 disabled:no-underline"
                    )}
                  >
                    {depositLoading ? "Depositing..." : "Deposit shortfall"}
                  </button>
                )}
              </>
            )}
          </div>
        )}

        {/* Payment request / QR - only if unpaid, owed to a payer with a wallet */}
        {!share.paid && !isPayerRow && payerWalletAddress && (
          <div className="pl-11">
            {paymentRequest ? (
              <PaymentRequestToggle
                input={{
                  kind: "share",
                  destination: payerWalletAddress,
                  source: share.walletAddress ?? null,
                  asset: paymentRequest.asset,
                  amount: paymentRequest.exactAmount,
                  tripId: paymentRequest.tripId,
                  items: [
                    { expenseId: paymentRequest.expenseId, memberId: share.memberId, amount: paymentRequest.exactAmount },
                  ],
                }}
              />
            ) : (
              // The QR pays the payer of the expense, never the debtor's own account.
              <QRToggle data={{ destination: payerWalletAddress, amount: share.amount, memo }} />
            )}
          </div>
        )}
      </motion.div>

      {/* Receipt modal */}
      {share.paid && share.txHash && (
        <ReceiptModal
          open={showReceipt}
          onClose={() => setShowReceipt(false)}
          txHash={share.txHash}
          memo={memo}
          amount={share.amount}
          recipientName={share.name}
        />
      )}
    </>
  );
}
