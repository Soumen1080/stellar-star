"use client";

import React from "react";
import { formatMoney } from "@/lib/money/format";
import { useLocale } from "@/context/LocaleContext";
import { cn } from "@/lib/utils";

export interface MoneyProps {
  /**
   * Accepts a `Money`/`Amount` instance as well as a primitive: `formatMoney`
   * already handles any object exposing `stroops` + `format()`, and callers pass
   * `Money` values straight through.
   */
  amount: number | string | bigint | { stroops: bigint; format?: (decimals?: number) => string };
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
  const { locale, isHydrated } = useLocale();
  const activeLocale = isHydrated ? locale : "en-US";
  const { formatted, a11y } = formatMoney(amount, asset, activeLocale, { showExact });

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
      suppressHydrationWarning
    >
      <span aria-hidden="true" className="inline-flex items-center" suppressHydrationWarning>
        {visualPrefix && <span className="mr-0.5 font-semibold select-none">{visualPrefix}</span>}
        <span suppressHydrationWarning>{formatted}</span>
      </span>
      <span className="sr-only">{fullLabel}</span>
    </span>
  );
}
export default Money;
