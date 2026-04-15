"use client";

import React from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { Users, ReceiptText, ChevronRight, Trash2, CheckCheck } from "lucide-react";
import type { Trip } from "@/types/trip";
import { cn } from "@/lib/utils";

interface TripCardProps {
  trip: Trip;
  expenseCount?: number;
  totalXLM?: number;
  onDelete: (id: string) => void;
  index?: number;
}

export function TripCard({
  trip,
  expenseCount = 0,
  totalXLM = 0,
  onDelete,
  index = 0,
}: TripCardProps) {
  const createdAt = new Date(trip.createdAt).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ delay: index * 0.04 }}
      className={cn(
        "bg-white rounded-2xl border overflow-hidden transition-all hover:shadow-sm",
        trip.settled ? "border-[#2DD4BF]/40" : "border-[#E5E5E5] hover:border-[#D0D0D0]"
      )}
    >
      <Link href={`/trips/${trip.id}`} className="block p-4">
        <div className="flex items-start justify-between gap-3">
          {/* Icon + info */}
          <div className="flex items-start gap-3 min-w-0">
            <div className="w-10 h-10 rounded-xl bg-[#0F0F14] flex items-center justify-center shrink-0">
              <span className="text-[#2DD4BF] text-base">✈</span>
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2 mb-0.5">
                <p className="text-sm font-bold text-[#0F0F14] truncate">{trip.name}</p>
                {trip.settled && (
                  <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase px-2 py-0.5 bg-[#2DD4BF]/30 text-[#134E4A] rounded-full">
                    <CheckCheck size={9} />
                    Settled
                  </span>
                )}
              </div>
              {trip.description && (
                <p className="text-xs text-[#888] truncate mb-1.5">{trip.description}</p>
              )}
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[#AAA]">
                <span className="flex items-center gap-1">
                  <Users size={10} />
                  {trip.members.length} members
                </span>
                <span className="flex items-center gap-1">
                  <ReceiptText size={10} />
                  {expenseCount} expense{expenseCount !== 1 ? "s" : ""}
                </span>
                {totalXLM > 0 && (
                  <span className="font-semibold text-[#555]">
                    {totalXLM.toFixed(4)} XLM
                  </span>
                )}
              </div>
            </div>
          </div>

          <ChevronRight size={14} className="text-[#CCC] shrink-0 mt-1" />
        </div>
      </Link>

      {/* Footer */}
      <div className="flex items-center justify-between px-4 py-3 border-t border-[#F5F5F5]">
        <span className="text-[10px] text-[#BBB]">{createdAt}</span>
        <button
          onClick={(e) => {
            e.preventDefault();
            onDelete(trip.id);
          }}
          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-[#CCC] hover:text-red-500 hover:bg-red-50 transition-colors"
        >
          <Trash2 size={11} />
          Delete
        </button>
      </div>
    </motion.div>
  );
}
