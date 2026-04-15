"use client";

import React, { useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { motion, AnimatePresence } from "framer-motion";
import { QrCode, Copy, Check, X } from "lucide-react";
import { buildQRPaymentURI } from "@/lib/qr/generator";
import type { QRPaymentData } from "@/lib/qr/generator";
import { cn } from "@/lib/utils";

// ─── Inline QR panel ──────────────────────────────────────────────────────────

interface QRCodeDisplayProps {
  data: QRPaymentData;
  className?: string;
}

export function QRCodeDisplay({ data, className }: QRCodeDisplayProps) {
  const [copied, setCopied] = useState(false);
  const uri = buildQRPaymentURI(data);

  const handleCopy = () => {
    navigator.clipboard.writeText(uri).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 p-4 bg-white rounded-2xl border border-[#E5E5E5]",
        className
      )}
    >
      <div className="p-3 bg-white rounded-xl shadow-sm border border-[#F0F0F0]">
        <QRCodeSVG
          value={uri}
          size={160}
          bgColor="#ffffff"
          fgColor="#0F0F14"
          level="M"
          includeMargin={false}
        />
      </div>

      <div className="text-center">
        <p className="text-xs font-semibold text-[#555] mb-0.5">
          Scan to pay {parseFloat(data.amount).toFixed(4)} XLM
        </p>
        <p className="text-[10px] text-[#AAA]">
          Works with Freighter, Lobstr &amp; SEP-0007 wallets
        </p>
      </div>

      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
      >
        {copied ? (
          <>
            <Check size={12} className="text-[#134E4A]" />
            <span className="text-[#134E4A]">Copied!</span>
          </>
        ) : (
          <>
            <Copy size={12} />
            Copy payment link
          </>
        )}
      </button>
    </div>
  );
}

// ─── Trigger button + inline toggle ──────────────────────────────────────────

interface QRToggleProps {
  data: QRPaymentData;
}

export function QRToggle({ data }: QRToggleProps) {
  const [open, setOpen] = useState(false);

  return (
    <div>
      <button
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#888] hover:text-[#0F0F14] transition-colors"
        title="Show QR code"
      >
        {open ? <X size={12} /> : <QrCode size={12} />}
        {open ? "Hide QR" : "QR Code"}
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="overflow-hidden mt-2"
          >
            <QRCodeDisplay data={data} />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
