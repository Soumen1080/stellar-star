"use client";

import { Check, X } from "lucide-react";
import type { CopyPreview } from "@/lib/trip/templates";

interface TripCopyPreviewProps {
  preview: CopyPreview;
  title?: string;
}

/** Shows, before anything is written, exactly what a copy brings and leaves. */
export function TripCopyPreview({ preview, title = "What will be copied" }: TripCopyPreviewProps) {
  return (
    <section
      aria-label={title}
      className="rounded-xl border border-[#E5E5E5] bg-[#FAFAFA] p-4 grid grid-cols-1 sm:grid-cols-2 gap-4"
    >
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-[#134E4A] mb-2">{title}</h3>
        <ul className="space-y-1.5">
          {preview.copied.map((line) => (
            <li key={line} className="flex items-start gap-1.5 text-xs text-[#333]">
              <Check size={12} className="mt-0.5 shrink-0 text-[#0F766E]" />
              {line}
            </li>
          ))}
        </ul>
      </div>
      <div>
        <h3 className="text-xs font-bold uppercase tracking-wide text-[#888] mb-2">Never copied</h3>
        <ul className="space-y-1.5">
          {preview.excluded.map((line) => (
            <li key={line} className="flex items-start gap-1.5 text-xs text-[#888]">
              <X size={12} className="mt-0.5 shrink-0 text-[#BBB]" />
              {line}
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
