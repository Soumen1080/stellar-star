"use client";

import React from "react";
import { Zap, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface PayButtonProps {
  amount: string;
  recipientName: string;
  onClick: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
}

export function PayButton({
  amount,
  recipientName,
  onClick,
  isLoading = false,
  disabled = false,
  className,
  size = "md",
}: PayButtonProps) {
  const xlm = parseFloat(amount).toFixed(4);

  return (
    <button
      onClick={onClick}
      disabled={disabled || isLoading}
      className={cn(
        "inline-flex items-center gap-1.5 font-bold rounded-xl transition-all",
        "bg-[#0F0F14] text-[#2DD4BF] hover:bg-[#1A1A22]",
        "disabled:opacity-50 disabled:cursor-not-allowed",
        size === "sm"
          ? "text-xs px-3 py-1.5"
          : "text-sm px-4 py-2.5",
        className
      )}
      title={`Pay ${xlm} XLM to ${recipientName}`}
    >
      {isLoading ? (
        <Loader2 size={size === "sm" ? 11 : 14} className="animate-spin" />
      ) : (
        <Zap size={size === "sm" ? 11 : 14} className="fill-[#2DD4BF]" />
      )}
      {isLoading ? "Paying…" : `Pay ${xlm} XLM`}
    </button>
  );
}
