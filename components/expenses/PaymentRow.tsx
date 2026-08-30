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
import { ReceiptModal } from "@/components/expenses/ReceiptModal";
import { trimToMemoBytes } from "@/lib/stellar/buildTransaction";
import { Money } from "@/components/ui/Money";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PaymentRowProps {
  share: SplitShare;
  index: number;
  expenseTitle?: string;
  /** Called when user clicks "Pay". */
  onPay?: (share: SplitShare) => void;
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
}: PaymentRowProps) {
  const [showReceipt, setShowReceipt] = useState(false);
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
  const poolBalanceValue = poolBalance === null || poolBalance === undefined ? null : parseFloat(poolBalance);
  const shareAmountValue = parseFloat(share.amount);
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

            {share.paid ? (
              <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                Paid
              </span>
            ) : isMyRow ? (
              <PayButton
                amount={share.amount}
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

        {/* QR toggle - only if unpaid and has wallet address */}
        {!share.paid && share.walletAddress && (
          <div className="pl-11">
            <QRToggle
              data={{ destination: share.walletAddress, amount: share.amount, memo }}
            />
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
