"use client";

import React from "react";
import { cn } from "@/lib/utils";

interface SpinnerProps {
  /** px size of the spinner ring */
  size?: number;
  className?: string;
}

/**
 * Lightweight SVG spinner using the brand lime colour.
 */
export function Spinner({ size = 18, className }: SpinnerProps) {
  return (
    <svg
      className={cn("animate-spin", className)}
      xmlns="http://www.w3.org/2000/svg"
      fill="none"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      aria-hidden="true"
    >
      {/* Track */}
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="3"
        className="opacity-20"
      />
      {/* Arc */}
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
    </svg>
  );
}
