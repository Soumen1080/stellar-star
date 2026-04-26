import React from "react";
import { cn } from "@/lib/utils";

interface SettleXLogoProps {
  /** Controls the overall scale of the logo */
  size?: "sm" | "md" | "lg" | "xl";
  /** Show only the icon mark without the wordmark text */
  iconOnly?: boolean;
  /**
   * "light" — dark wordmark for light backgrounds (default)
   * "dark"  — white wordmark for dark backgrounds
   */
  variant?: "light" | "dark";
  className?: string;
}

const SIZE_MAP = {
  sm: { iconSize: 26, fontSize: "text-base",  gap: "gap-1.5" },
  md: { iconSize: 32, fontSize: "text-lg",    gap: "gap-2"   },
  lg: { iconSize: 40, fontSize: "text-2xl",   gap: "gap-2.5" },
  xl: { iconSize: 52, fontSize: "text-3xl",   gap: "gap-3"   },
};

/**
 * SettleX brand logo — inline SVG so it works without any image requests,
 * renders crisp at every size, and respects the app's colour tokens.
 */
export function SettleXLogo({
  size    = "md",
  iconOnly = false,
  variant  = "light",
  className,
}: SettleXLogoProps) {
  const { iconSize, fontSize, gap } = SIZE_MAP[size];
  const r = Math.round(iconSize * 0.25);
  const wordmarkColor = variant === "dark" ? "#FFFFFF" : "#0F0F14";

  return (
    <div className={cn("flex items-center", gap, className)}>
      {/* ── Logomark ── */}
      <svg
        width={iconSize}
        height={iconSize}
        viewBox="0 0 512 512"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
        style={{ borderRadius: r, flexShrink: 0 }}
      >
        {/* Background */}
        <rect width="512" height="512" rx="110" fill="#0F0F14" />

        {/* Lightning bolt — the settlement / speed symbol */}
        <path
          d="M 308 58 L 172 272 H 264 L 200 454 L 340 240 H 248 L 308 58 Z"
          fill="#2DD4BF"
        />

        {/* Subtle glow dot — on-chain accent */}
        <circle cx="362" cy="390" r="28" fill="#2DD4BF" opacity="0.3" />
      </svg>

      {/* ── Wordmark ── */}
      {!iconOnly && (
        <span
          className={cn(
            "font-black tracking-tight leading-none select-none",
            fontSize,
          )}
        >
          <span style={{ color: wordmarkColor }}>Settle</span>
          <span
            className="text-[#2DD4BF]"
            style={{ textShadow: "0 0 24px rgba(45,212,191,0.4)" }}
          >
            X
          </span>
        </span>
      )}
    </div>
  );
}

