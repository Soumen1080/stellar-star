"use client";

import { useEffect, useState } from "react";
import { AlertCircle, XCircle, RefreshCw, ChevronDown, ChevronUp, ShieldAlert } from "lucide-react";
import { categorizeError } from "@/lib/observability/errorTaxonomy";
import { reportError } from "@/lib/observability/reportError";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const cat = categorizeError(error);

  useEffect(() => {
    reportError("GlobalError.Crash", error, {
      digest: error.digest,
      category: cat.category,
    });
  }, [error, cat.category]);

  return (
    <html lang="en">
      <body className="bg-[#F6F6F6] text-[#0F0F14] font-sans antialiased min-h-screen flex flex-col items-center justify-center px-4 py-12 text-center">
        <div className="max-w-md w-full bg-white border border-[#E5E5E5] rounded-3xl p-6 sm:p-8 shadow-[0_8px_32px_rgba(0,0,0,0.04)] animate-in fade-in zoom-in duration-200">
          <div className="w-16 h-16 rounded-2xl mx-auto flex items-center justify-center mb-6 bg-red-50 border border-red-100 text-red-500">
            {cat.category === "ambiguous_submission" ? (
              <AlertCircle size={28} className="text-amber-500" />
            ) : cat.category === "permission_denied" ? (
              <ShieldAlert size={28} className="text-red-500" />
            ) : (
              <XCircle size={28} />
            )}
          </div>

          <h1 className="text-xl font-bold text-[#0F0F14] mb-2">{cat.title}</h1>
          <p className="text-sm text-[#555] mb-6 max-w-xs mx-auto leading-relaxed">
            {cat.copy}
          </p>

          <div className="flex flex-col sm:flex-row gap-3 justify-center mb-6">
            {cat.safeToRetry && (
              <button
                onClick={() => reset()}
                className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[#0F0F14] text-[#2DD4BF] text-sm font-bold hover:bg-[#1A1A22] transition-all"
              >
                <RefreshCw size={14} />
                Try again
              </button>
            )}
            <a
              href="/"
              className="inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl border border-[#E5E5E5] bg-white text-[#555] text-sm font-semibold hover:bg-[#F9F9F9] transition-all cursor-pointer"
            >
              Back to Home
            </a>
          </div>

          <div className="border-t border-[#F0F0F0] pt-4 text-left">
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="w-full flex items-center justify-between text-xs text-[#888] hover:text-[#555] font-semibold transition-colors"
            >
              <span>Technical details</span>
              {showDetails ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            </button>

            {showDetails && (
              <div className="mt-3 p-3 rounded-xl bg-[#F8F8F8] border border-[#E9E9E9] text-[11px] text-[#666] font-mono overflow-auto max-h-40 whitespace-pre-wrap break-all">
                <p className="font-bold text-[#333] mb-1">Error: {error.name || "Error"}</p>
                <p className="mb-2">{error.message}</p>
                {error.stack && <p className="text-[10px] leading-normal text-[#999]">{error.stack}</p>}
              </div>
            )}
          </div>
        </div>
      </body>
    </html>
  );
}
