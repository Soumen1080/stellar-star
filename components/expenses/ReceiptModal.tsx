"use client";

import React from "react";
import { CheckCircle2, ExternalLink, Layers } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import { TransactionHash } from "@/components/payment/TransactionHash";
import { STELLAR_EXPLORER } from "@/lib/utils/constants";
import { cn } from "@/lib/utils";

export interface ReceiptModalProps {
  open: boolean;
  onClose: () => void;
  txHash: string;
  memo: string;
  /** XLM amount string, e.g. "300.0000000" */
  amount: string;
  recipientName: string;
  ledger?: number;
}

export function ReceiptModal({
  open,
  onClose,
  txHash,
  memo,
  amount,
  recipientName,
  ledger,
}: ReceiptModalProps) {
  const explorerUrl = `${STELLAR_EXPLORER}/tx/${txHash}`;
  const displayAmount = parseFloat(amount).toFixed(4);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Payment Receipt"
      size="sm"
    >
      {/* ── Paid badge ── */}
      <div className="flex flex-col items-center gap-2 mb-6">
        <div className="w-14 h-14 rounded-full bg-[#2DD4BF]/20 flex items-center justify-center">
          <CheckCircle2 size={32} className="text-[#134E4A]" />
        </div>
        <p className="text-xl font-bold text-[#0F0F14]">Payment Confirmed</p>
        <p className="text-sm text-[#888]">Successfully sent on Stellar Testnet</p>
      </div>

      {/* ── Summary rows ── */}
      <dl className="space-y-2 mb-5">
        <ReceiptRow label="Recipient" value={recipientName} />
        <ReceiptRow
          label="Amount"
          value={
            <span className="font-bold text-[#2DD4BF] bg-[#0F0F14] px-2 py-0.5 rounded text-sm">
              {displayAmount} XLM
            </span>
          }
        />
        <ReceiptRow
          label="Memo"
          value={
            <span className="font-mono text-xs break-all">{memo}</span>
          }
          hint="Stored on-chain with the transaction"
        />
        {ledger !== undefined && (
          <ReceiptRow label="Ledger" value={`#${ledger}`} />
        )}
      </dl>

      {/* ── TX hash ── */}
      <div className="p-3 bg-[#F6F6F6] rounded-xl mb-5">
        <p className="text-[10px] font-semibold text-[#AAA] uppercase tracking-wide mb-1.5">
          Transaction Hash
        </p>
        <TransactionHash hash={txHash} />
      </div>

      {/* ── Stellar Expert link ── */}
      <a
        href={explorerUrl}
        target="_blank"
        rel="noopener noreferrer"
        className={cn(
          "flex items-center justify-center gap-2 w-full py-2.5 rounded-xl",
          "bg-[#0F0F14] text-white text-sm font-semibold",
          "hover:bg-[#1a1a24] transition-colors"
        )}
      >
        <Layers size={14} />
        View on Stellar Expert
        <ExternalLink size={12} className="opacity-60" />
      </a>
    </Modal>
  );
}

// ─── Helper ───────────────────────────────────────────────────────────────────

function ReceiptRow({
  label,
  value,
  hint,
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <dt className="text-xs font-semibold text-[#888]">{label}</dt>
        {hint && <p className="text-[10px] text-[#BBB]">{hint}</p>}
      </div>
      <dd className="text-sm text-[#0F0F14] text-right">{value}</dd>
    </div>
  );
}
