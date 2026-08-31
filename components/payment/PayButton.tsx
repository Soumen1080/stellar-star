"use client";

import React from "react";
import { Zap, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

import { Money } from "@/components/ui/Money";
import { formatMoney } from "@/lib/money/format";
import { useLocale } from "@/context/LocaleContext";

interface PayButtonProps {
  amount: string;
  asset?: string;
  recipientName: string;
  onClick: () => void;
  isLoading?: boolean;
  disabled?: boolean;
  className?: string;
  size?: "sm" | "md";
}

export function PayButton({
  amount,
  asset = "XLM",
  recipientName,
  onClick,
  isLoading = false,
  disabled = false,
  className,
  size = "md",
}: PayButtonProps) {
  const { locale } = useLocale();
  const displayAsset = asset === "native" ? "XLM" : asset.split(":")[0];
  const { formatted } = formatMoney(amount, displayAsset, locale);
  const titleText = `Pay ${formatted} to ${recipientName}`;

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
      title={titleText}
    >
      {isLoading ? (
        <Loader2 size={size === "sm" ? 11 : 14} className="animate-spin" />
      ) : (
        <Zap size={size === "sm" ? 11 : 14} className="fill-[#2DD4BF]" />
      )}
      {isLoading ? (
        "Paying..."
      ) : (
        <span className="flex items-center gap-1">
          <span>Pay </span>
          <Money amount={amount} asset={displayAsset} />
        </span>
      )}
    </button>
  );
}
