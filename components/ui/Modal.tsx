"use client";

import React, { useEffect } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children: React.ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** Prevent closing when clicking the backdrop */
  disableBackdropClose?: boolean;
  className?: string;
}

const sizeClasses: Record<NonNullable<ModalProps["size"]>, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-lg",
  xl: "max-w-2xl",
};

// ─── Modal ────────────────────────────────────────────────────────────────────

export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  size = "md",
  disableBackdropClose = false,
  className,
}: ModalProps) {
  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const portal = (
    <AnimatePresence>
      {open && (
        <>
          {/* Backdrop */}
          <motion.div
            key="backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm"
            onClick={disableBackdropClose ? undefined : onClose}
            aria-hidden="true"
          />

          {/* Panel — bottom-sheet on mobile, centred on sm+ */}
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 pointer-events-none">
            <motion.div
              key="panel"
              initial={{ opacity: 0, y: 40, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.98 }}
              transition={{ duration: 0.25, ease: [0.22, 1, 0.36, 1] }}
              className={cn(
                "relative w-full pointer-events-auto",
                "bg-white shadow-[0_24px_80px_-12px_rgba(0,0,0,0.2)]",
                "border-t sm:border border-[#E5E5E5]",
                // Bottom-sheet rounded corners on mobile; full rounding on sm+
                "rounded-t-2xl sm:rounded-2xl",
                // Constrain height so content stays scrollable
                "flex flex-col max-h-[92dvh] sm:max-h-[90dvh]",
                sizeClasses[size],
                className
              )}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-modal="true"
              aria-labelledby={title ? "modal-title" : undefined}
            >
              {/* Drag handle — mobile only */}
              <div className="flex justify-center pt-3 sm:hidden">
                <div className="w-8 h-1 rounded-full bg-[#D0D0D0]" />
              </div>

              {/* Header */}
              {(title || description) && (
                <div className="flex items-start justify-between gap-4 px-5 sm:px-6 pt-4 sm:pt-6 pb-0 shrink-0">
                  <div>
                    {title && (
                      <h2
                        id="modal-title"
                        className="text-base font-bold text-[#0F0F14]"
                      >
                        {title}
                      </h2>
                    )}
                    {description && (
                      <p className="mt-1 text-sm text-[#888]">{description}</p>
                    )}
                  </div>
                  <button
                    onClick={onClose}
                    className="shrink-0 w-7 h-7 rounded-lg flex items-center justify-center text-[#AAA] hover:text-[#555] hover:bg-[#F5F5F5] transition-colors"
                    aria-label="Close modal"
                  >
                    <X size={15} />
                  </button>
                </div>
              )}

              {/* No header — floating close button */}
              {!title && !description && (
                <button
                  onClick={onClose}
                  className="absolute top-4 right-4 z-10 w-7 h-7 rounded-lg flex items-center justify-center text-[#AAA] hover:text-[#555] hover:bg-[#F5F5F5] transition-colors"
                  aria-label="Close modal"
                >
                  <X size={15} />
                </button>
              )}

              {/* Scrollable body */}
              <div className="px-5 sm:px-6 py-5 sm:py-6 overflow-y-auto flex-1 min-h-0">
                {children}
              </div>
            </motion.div>
          </div>
        </>
      )}
    </AnimatePresence>
  );

  if (typeof window === "undefined") return null;
  return createPortal(portal, document.body);
}

// ─── Modal footer helper ──────────────────────────────────────────────────────

export function ModalFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex items-center justify-end gap-2 pt-4 mt-2 border-t border-[#F0F0F0]",
        className
      )}
    >
      {children}
    </div>
  );
}
