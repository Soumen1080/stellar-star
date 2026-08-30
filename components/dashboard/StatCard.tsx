"use client";

import type { ElementType } from "react";

interface StatCardProps {
  label: string;
  value: React.ReactNode;
  sub?: string;
  icon: ElementType;
  accent?: boolean;
}

export function StatCard({ label, value, sub, icon: Icon, accent }: StatCardProps) {
  return (
    <div
      className={`rounded-2xl border p-4 ${
        accent ? "bg-[#0F0F14] border-transparent" : "bg-white border-[#E5E5E5]"
      }`}
    >
      <Icon size={14} className={accent ? "text-[#2DD4BF] mb-2" : "text-[#AAA] mb-2"} />
      <p className={`text-xl font-black ${accent ? "text-[#2DD4BF]" : "text-[#0F0F14]"}`}>
        {value}
      </p>
      <p className={`text-xs font-semibold mt-0.5 ${accent ? "text-[#666]" : "text-[#888]"}`}>
        {label}
      </p>
      {sub && (
        <p className={`text-[10px] mt-0.5 ${accent ? "text-[#555]" : "text-[#AAA]"}`}>
          {sub}
        </p>
      )}
    </div>
  );
}
