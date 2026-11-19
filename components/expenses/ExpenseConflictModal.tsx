"use client";

import React, { useState, useEffect } from "react";
import { AlertTriangle, RefreshCw, GitMerge, Check, X, ShieldAlert } from "lucide-react";
import type { ConflictDetails } from "@/lib/expense/conflictResolver";
import type { Expense } from "@/types/expense";

interface ExpenseConflictModalProps {
  open: boolean;
  onClose: () => void;
  conflict: ConflictDetails;
  onReloadLatest: (latestServerExpense: Expense) => void;
  onResolveAndMerge: (resolvedUpdates: Partial<Expense>) => void;
}

export function ExpenseConflictModal({
  open,
  onClose,
  conflict,
  onReloadLatest,
  onResolveAndMerge,
}: ExpenseConflictModalProps) {
    // Track resolution choices for each conflicting scalar field: "mine" vs "server"
  const [resolutions, setResolutions] = useState<Record<string, "mine" | "server">>({});

  useEffect(() => {
    if (conflict?.fields) {
      const initial: Record<string, "mine" | "server"> = {};
      for (const field of conflict.fields) {
        initial[field] = "mine";
      }
      setResolutions(initial);
    }
  }, [conflict]);

  if (!open || !conflict) return null;

  const { serverExpense, proposedUpdates, fields, reason } = conflict;

  const handleApplyMerge = () => {
    const resolvedUpdates: Partial<Expense> = { ...proposedUpdates };

    for (const field of fields) {
      if (resolutions[field] === "server") {
        (resolvedUpdates as any)[field] = (serverExpense as any)[field];
      }
    }

    onResolveAndMerge(resolvedUpdates);
  };

  const renderFieldComparison = (field: string) => {
    let myVal = String((proposedUpdates as any)[field] ?? "—");
    let serverVal = String((serverExpense as any)[field] ?? "—");

    if (field === "members") {
      myVal = `${proposedUpdates.members?.length ?? 0} members`;
      serverVal = `${serverExpense.members.length} members`;
    }

    return (
      <div key={field} className="p-3 bg-[#F9F9F9] border border-[#E5E5E5] rounded-xl space-y-2">
        <div className="flex items-center justify-between text-xs font-semibold text-[#0F0F14] uppercase tracking-wider">
          <span>Field: {field}</span>
          <span className="text-[11px] font-mono text-amber-700 bg-amber-50 px-2 py-0.5 rounded">
            Conflict
          </span>
        </div>

        <div className="grid grid-cols-2 gap-2 text-xs">
          <label
            onClick={() => setResolutions((prev) => ({ ...prev, [field]: "mine" }))}
            className={`p-2.5 rounded-lg border cursor-pointer transition-all flex flex-col justify-between ${
              resolutions[field] === "mine"
                ? "bg-white border-[#2DD4BF] ring-1 ring-[#2DD4BF]"
                : "bg-white/60 border-[#E5E5E5] hover:border-[#D0D0D0]"
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-[#0F0F14]">Your Value</span>
              <input
                type="radio"
                name={`res-${field}`}
                checked={resolutions[field] === "mine"}
                onChange={() => {}}
                className="text-[#2DD4BF] focus:ring-[#2DD4BF]"
              />
            </div>
            <p className="font-mono text-[#444] truncate">{myVal}</p>
          </label>

          <label
            onClick={() => setResolutions((prev) => ({ ...prev, [field]: "server" }))}
            className={`p-2.5 rounded-lg border cursor-pointer transition-all flex flex-col justify-between ${
              resolutions[field] === "server"
                ? "bg-white border-[#2DD4BF] ring-1 ring-[#2DD4BF]"
                : "bg-white/60 border-[#E5E5E5] hover:border-[#D0D0D0]"
            }`}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="font-semibold text-[#0F0F14]">Server&apos;s Value</span>
              <input
                type="radio"
                name={`res-${field}`}
                checked={resolutions[field] === "server"}
                onChange={() => {}}
                className="text-[#2DD4BF] focus:ring-[#2DD4BF]"
              />
            </div>
            <p className="font-mono text-[#444] truncate">{serverVal}</p>
          </label>
        </div>
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl max-w-lg w-full p-6 shadow-2xl space-y-4 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between border-b border-[#F0F0F0] pb-3">
          <div className="flex items-center gap-2">
            <span className="p-2 bg-amber-50 text-amber-700 rounded-xl">
              <AlertTriangle className="w-5 h-5" />
            </span>
            <div>
              <h3 className="text-base font-bold text-[#0F0F14]">
                Concurrent Edit Detected
              </h3>
              <p className="text-xs text-[#666]">
                Another member modified this expense simultaneously (Server: v{serverExpense.version ?? 1}).
              </p>
            </div>
          </div>
          <button onClick={onClose} className="text-[#888] hover:text-[#0F0F14] text-sm">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-[#555] leading-relaxed">
          {reason} To prevent silently overwriting someone else&apos;s changes, choose whether to reload the latest version from the server or merge your changes.
        </p>

        {fields.length > 0 && (
          <div className="space-y-2.5">
            <p className="text-xs font-semibold text-[#444] uppercase tracking-wider">
              Resolve Colliding Fields:
            </p>
            {fields.map(renderFieldComparison)}
          </div>
        )}

        <div className="pt-3 border-t border-[#F0F0F0] flex flex-col sm:flex-row items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={() => onReloadLatest(serverExpense)}
            className="w-full sm:w-auto px-4 py-2.5 text-xs font-semibold text-[#0F0F14] bg-[#F6F6F6] hover:bg-[#EDEDED] rounded-xl transition-colors flex items-center justify-center gap-1.5"
          >
            <RefreshCw className="w-3.5 h-3.5 text-[#666]" />
            Reload Latest Version
          </button>

          <button
            type="button"
            onClick={handleApplyMerge}
            className="w-full sm:w-auto px-4 py-2.5 text-xs font-semibold text-white bg-[#0F0F14] hover:bg-[#222] rounded-xl transition-colors flex items-center justify-center gap-1.5"
          >
            <GitMerge className="w-3.5 h-3.5 text-[#2DD4BF]" />
            Merge & Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
