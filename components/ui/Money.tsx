"use client";

import React from "react";
import { formatMoney } from "@/lib/money/format";
import { useLocale } from "@/context/LocaleContext";
import { cn } from "@/lib/utils";

export interface MoneyProps {
  amount: number | string | bigint;
  asset: string;
  showExact?: boolean;
  direction?: "owe" | "owed" | "none";
  className?: string;
  style?: React.CSSProperties;
}

export function Money({
  amount,
  asset,
  showExact = false,
  direction = "none",
  className,
  style,
}: MoneyProps) {
  const { locale } = useLocale();
  const { formatted, a11y } = formatMoney(amount, asset, locale, { showExact });

  let visualPrefix = "";
  let directionText = "";
  if (direction === "owe") {
    visualPrefix = "-";
    directionText = "You owe";
  } else if (direction === "owed") {
    visualPrefix = "+";
    directionText = "You are owed";
  }

  const fullLabel = directionText ? `${directionText} ${a11y}` : a11y;

  return (
    <span
      className={cn("inline-flex items-center", className)}
      style={style}
      title={fullLabel}
    >
      <span aria-hidden="true" className="inline-flex items-center">
        {visualPrefix && <span className="mr-0.5 font-semibold select-none">{visualPrefix}</span>}
        <span>{formatted}</span>
      </span>
      <span className="sr-only">{fullLabel}</span>
    </span>
  );
}
export default Money;
