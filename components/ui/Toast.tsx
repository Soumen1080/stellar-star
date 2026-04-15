"use client";

import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { AnimatePresence, motion } from "framer-motion";
import { CheckCircle2, XCircle, Info, X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ────────────────────────────────────────────────────────────────────

type ToastVariant = "success" | "error" | "info";

interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
}

interface ToastContextType {
  toast: (opts: Omit<Toast, "id">) => void;
  success: (title: string, description?: string) => void;
  error: (title: string, description?: string) => void;
  info: (title: string, description?: string) => void;
}

// ─── Context ──────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextType | null>(null);

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within <ToastProvider />");
  return ctx;
}

// ─── Individual Toast Card ────────────────────────────────────────────────────

const icons: Record<ToastVariant, React.ReactNode> = {
  success: <CheckCircle2 size={16} className="text-[#134E4A]" />,
  error: <XCircle size={16} className="text-red-500" />,
  info: <Info size={16} className="text-blue-500" />,
};

const variantStyles: Record<ToastVariant, string> = {
  success:
    "bg-white border-[#2DD4BF]/60 shadow-[0_4px_24px_-4px_rgba(185,255,102,0.25)]",
  error:
    "bg-white border-red-200 shadow-[0_4px_24px_-4px_rgba(239,68,68,0.15)]",
  info: "bg-white border-blue-200 shadow-[0_4px_24px_-4px_rgba(59,130,246,0.15)]",
};

const AUTO_DISMISS_MS = 4000;

function ToastCard({
  toast: t,
  onDismiss,
}: {
  toast: Toast;
  onDismiss: (id: string) => void;
}) {
  const ref = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ref.current = setTimeout(() => onDismiss(t.id), AUTO_DISMISS_MS);
    return () => {
      if (ref.current) clearTimeout(ref.current);
    };
  }, [t.id, onDismiss]);

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 20, scale: 0.95 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: 10, scale: 0.95 }}
      transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
      className={cn(
        "flex items-start gap-3 w-full max-w-sm rounded-2xl border px-4 py-3 pointer-events-auto",
        variantStyles[t.variant]
      )}
    >
      <div className="shrink-0 mt-0.5">{icons[t.variant]}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-[#0F0F14] leading-snug">{t.title}</p>
        {t.description && (
          <p className="text-xs text-[#666] mt-0.5 leading-snug">{t.description}</p>
        )}
      </div>
      <button
        onClick={() => onDismiss(t.id)}
        className="shrink-0 text-[#AAA] hover:text-[#555] transition-colors mt-0.5"
        aria-label="Dismiss"
      >
        <X size={14} />
      </button>
    </motion.div>
  );
}

// ─── Provider ─────────────────────────────────────────────────────────────────

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((opts: Omit<Toast, "id">) => {
    const id = Math.random().toString(36).slice(2);
    setToasts((prev) => [...prev.slice(-4), { ...opts, id }]); // max 5 at once
  }, []);

  const ctx: ToastContextType = {
    toast: addToast,
    success: (title, description) =>
      addToast({ variant: "success", title, description }),
    error: (title, description) =>
      addToast({ variant: "error", title, description }),
    info: (title, description) =>
      addToast({ variant: "info", title, description }),
  };

  return (
    <ToastContext.Provider value={ctx}>
      {children}

      {/* Toast viewport — fixed bottom-right */}
      <div
        className="fixed bottom-4 right-4 z-[200] flex flex-col gap-2 pointer-events-none"
        aria-live="polite"
        aria-atomic="false"
      >
        <AnimatePresence initial={false} mode="sync">
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}
