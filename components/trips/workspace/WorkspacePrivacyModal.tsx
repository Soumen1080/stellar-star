"use client";

import React, { useState } from "react";
import { ShieldCheck, Download, Trash2, AlertTriangle, FileJson } from "lucide-react";
import { Modal } from "@/components/ui/Modal";
import type { Trip } from "@/types/trip";
import type { TravelWorkspace } from "@/types/workspace";
import {
  buildTravelWorkspaceExport,
  TRAVEL_WORKSPACE_PRIVACY_POLICY,
} from "@/lib/workspace/privacy";
import { downloadText } from "@/lib/export/download";
import { useToast } from "@/components/ui/Toast";

interface WorkspacePrivacyModalProps {
  isOpen: boolean;
  onClose: () => void;
  trip: Trip;
  workspace: TravelWorkspace;
  currentUserWallet?: string | null;
  onPurgeWorkspace: () => Promise<void>;
}

export function WorkspacePrivacyModal({
  isOpen,
  onClose,
  trip,
  workspace,
  currentUserWallet,
  onPurgeWorkspace,
}: WorkspacePrivacyModalProps) {
  const { success: toastSuccess, error: toastError } = useToast();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const handleExportJson = () => {
    try {
      const exportData = buildTravelWorkspaceExport(
        trip,
        workspace,
        currentUserWallet
      );
      const filename = `${trip.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") || "trip"}-travel-workspace.json`;
      downloadText(
        filename,
        JSON.stringify(exportData, null, 2),
        "application/json"
      );
      toastSuccess("Export complete", "Travel workspace content exported as JSON.");
    } catch (err: any) {
      toastError("Export failed", err?.message || "Please try again.");
    }
  };

  const handleDeleteContent = async () => {
    setDeleting(true);
    try {
      await onPurgeWorkspace();
      setConfirmDelete(false);
      onClose();
    } catch (err: any) {
      toastError("Failed to delete travel content", err?.message || "Please try again.");
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      open={isOpen}
      onClose={() => {
        setConfirmDelete(false);
        onClose();
      }}
      title="Travel Workspace Privacy & Data Policy"
      description="Privacy guarantees, travel data portability, and erasure under our privacy policy."
      size="md"
    >
      <div className="space-y-4 pt-1">
        {/* Zero on-chain guarantee badge */}
        <div className="p-3 bg-emerald-50 border border-emerald-200/80 rounded-xl text-xs space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-emerald-900">
            <ShieldCheck size={16} className="text-emerald-600" />
            <span>Strict Zero On-Chain Leakage Guarantee</span>
          </div>
          <p className="text-emerald-800 text-[11px] leading-relaxed">
            All itinerary schedules, collaborative packing checklists, chore completion history, booking confirmation
            codes, files, and reference links are isolated off-chain. They are NEVER published to
            public Stellar blockchain transactions, memos, or Soroban smart contracts.
          </p>
        </div>

        {/* Policy points */}
        <div className="p-3 bg-white rounded-xl border border-[#DDD] max-h-40 overflow-y-auto text-[11px] text-[#555] whitespace-pre-line leading-relaxed font-mono">
          {TRAVEL_WORKSPACE_PRIVACY_POLICY}
        </div>

        {/* Data actions */}
        <div className="space-y-2 pt-1">
          <span className="block text-xs font-semibold text-[#0F0F14]">
            Member Data Rights
          </span>

          <div className="flex flex-col sm:flex-row items-stretch gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-white border border-[#DDD] text-[#0F0F14] hover:bg-[#F6F6F6] transition-colors"
            >
              <FileJson size={14} className="text-[#2DD4BF]" />
              Export Travel Data (.json)
            </button>

            {!confirmDelete ? (
              <button
                type="button"
                onClick={() => setConfirmDelete(true)}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-xl bg-red-50 border border-red-200 text-red-700 hover:bg-red-100 transition-colors"
              >
                <Trash2 size={14} />
                Delete Travel Content
              </button>
            ) : (
              <button
                type="button"
                onClick={handleDeleteContent}
                disabled={deleting}
                className="flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 text-xs font-bold rounded-xl bg-red-600 text-white hover:bg-red-700 transition-colors disabled:opacity-50"
              >
                <AlertTriangle size={14} />
                {deleting ? "Deleting…" : "Confirm Delete Travel Content"}
              </button>
            )}
          </div>
          {confirmDelete && (
            <p className="text-[11px] text-red-600 leading-tight">
              Are you sure? This deletes all travel itinerary, checklists, chores, and booking references.
              Trip expenses, shares, balances, and on-chain settlements will NOT be affected.
            </p>
          )}
        </div>

        <div className="flex items-center justify-end pt-2 border-t border-[#EBEBEB]">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-xs font-semibold text-[#777] hover:text-[#0F0F14] transition-colors"
          >
            Close
          </button>
        </div>
      </div>
    </Modal>
  );
}
