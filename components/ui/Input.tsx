"use client";

import React from "react";
import { cn } from "@/lib/utils";

// ─── Input ────────────────────────────────────────────────────────────────────

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  error?: string;
  hint?: string;
  leading?: React.ReactNode;   // icon/text inside left edge
  trailing?: React.ReactNode;  // icon/text inside right edge
}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  (
    {
      label,
      error,
      hint,
      leading,
      trailing,
      className,
      id,
      required,
      ...props
    },
    ref
  ) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-[#444] uppercase tracking-wide"
          >
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}

        <div className="relative flex items-center">
          {leading && (
            <div className="absolute left-3 flex items-center pointer-events-none text-[#AAA]">
              {leading}
            </div>
          )}

          <input
            ref={ref}
            id={inputId}
            required={required}
            className={cn(
              "w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-[#0F0F14]",
              "placeholder:text-[#CCC] outline-none transition-all duration-150",
              "border-[#E5E5E5] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20",
              error && "border-red-300 focus:border-red-400 focus:ring-red-100",
              leading  && "pl-9",
              trailing && "pr-9",
              className
            )}
            {...props}
          />

          {trailing && (
            <div className="absolute right-3 flex items-center pointer-events-none text-[#AAA]">
              {trailing}
            </div>
          )}
        </div>

        {error && (
          <p className="text-xs font-medium text-red-500">{error}</p>
        )}
        {hint && !error && (
          <p className="text-xs text-[#AAA]">{hint}</p>
        )}
      </div>
    );
  }
);

Input.displayName = "Input";

// ─── Textarea variant ─────────────────────────────────────────────────────────

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  error?: string;
  hint?: string;
}

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ label, error, hint, className, id, required, ...props }, ref) => {
    const inputId = id ?? label?.toLowerCase().replace(/\s+/g, "-");

    return (
      <div className="flex flex-col gap-1.5">
        {label && (
          <label
            htmlFor={inputId}
            className="text-xs font-semibold text-[#444] uppercase tracking-wide"
          >
            {label}
            {required && <span className="text-red-500 ml-0.5">*</span>}
          </label>
        )}
        <textarea
          ref={ref}
          id={inputId}
          required={required}
          className={cn(
            "w-full rounded-xl border bg-white px-3.5 py-2.5 text-sm text-[#0F0F14]",
            "placeholder:text-[#CCC] outline-none transition-all duration-150 resize-none",
            "border-[#E5E5E5] focus:border-[#2DD4BF] focus:ring-2 focus:ring-[#2DD4BF]/20",
            error && "border-red-300 focus:border-red-400 focus:ring-red-100",
            className
          )}
          rows={3}
          {...props}
        />
        {error && <p className="text-xs font-medium text-red-500">{error}</p>}
        {hint && !error && <p className="text-xs text-[#AAA]">{hint}</p>}
      </div>
    );
  }
);

Textarea.displayName = "Textarea";
