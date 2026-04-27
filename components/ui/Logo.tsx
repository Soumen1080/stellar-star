import React from "react";
import { cn } from "@/lib/utils";

interface StellarStarLogoProps {
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
 * Stellar Star brand logo — inline SVG so it works without any image requests,
 * renders crisp at every size, and respects the app's colour tokens.
 */
export function StellarStarLogo({
  size    = "md",
  iconOnly = false,
  variant  = "light",
  className,
}: StellarStarLogoProps) {
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

        {/* Star — the Stellar Star symbol */}
        <path
          d="M 256 72 L 306 196 L 440 196 L 330 280 L 370 408 L 256 328 L 142 408 L 182 280 L 72 196 L 206 196 Z"
          fill="#2DD4BF"
        />

        {/* Subtle glow — accent */}
        <circle cx="256" cy="256" r="40" fill="#2DD4BF" opacity="0.15" />
      </svg>

      {/* ── Wordmark ── */}
      {!iconOnly && (
        <span
          className={cn(
            "font-black tracking-tight leading-none select-none",
            fontSize,
          )}
        >
          <span style={{ color: wordmarkColor }}>Stellar</span>
          <span
            className="text-[#2DD4BF]"
            style={{ textShadow: "0 0 24px rgba(45,212,191,0.4)" }}
          >
            -star
          </span>
        </span>
      )}
    </div>
  );
}

/** @deprecated Use StellarStarLogo instead */
export const SettleXLogo = StellarStarLogo;
